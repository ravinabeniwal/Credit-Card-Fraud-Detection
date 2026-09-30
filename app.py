import io, json, os, re, shutil, sqlite3, threading, uuid
from functools import wraps
from datetime import datetime
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import xgboost as xgb
from flask import Flask, jsonify, render_template, request

import train as pipeline

BASE = Path(__file__).parent
MODEL_DIR = BASE / "model"
DB = BASE / "history.db"
MAX_ROWS = 20000
PUBLIC_DEMO = os.environ.get("PUBLIC_DEMO") == "1"  # set on a public deployment: disables admin actions
LOCK = threading.Lock()
RETRAIN_LOCK = threading.Lock()
VERSIONS = MODEL_DIR / "versions"
CAND = MODEL_DIR / "candidate"

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024

_ft = json.load(open(MODEL_DIR / "features.json"))
FEATURES = _ft["features"]  # the 30 raw inputs
MODEL_FEATURES = _ft.get("model_features", FEATURES)  # + engineered features (hour, log_amount)
S = {}  # model state: model, scaler, iso, metrics, threshold, samples


def load_model():
    from xgboost import XGBClassifier
    try:  # native format: portable across xgboost versions
        m = XGBClassifier()
        m.load_model(str(MODEL_DIR / "xgb_model.json"))
        return m
    except Exception:
        try:
            return joblib.load(MODEL_DIR / "xgb_model.joblib")
        except Exception:
            raise SystemExit("Model could not be loaded with the installed xgboost version. "
                             "Run: python train.py (needs data/creditcard.csv)")


def load_state():
    S["model"] = load_model()
    S["scaler"] = joblib.load(MODEL_DIR / "scaler.joblib")
    try:
        S["iso"] = joblib.load(MODEL_DIR / "anomaly.joblib")
    except Exception:
        S["iso"] = None  # anomaly score is optional
    try:
        S["cal"] = json.load(open(MODEL_DIR / "calibration.json"))
    except Exception:
        S["cal"] = None
    try:
        S["drift_ref"] = json.load(open(MODEL_DIR / "drift_ref.json"))
    except Exception:
        S["drift_ref"] = None
    S["metrics"] = json.load(open(MODEL_DIR / "metrics.json"))
    S["samples"] = json.load(open(MODEL_DIR / "samples.json"))
    try:
        S["threshold"] = float(json.load(open(MODEL_DIR / "config.json"))["threshold"])
    except Exception:
        S["threshold"] = 0.5


def db():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    return c


COLS = "id, amount, prediction, probability, risk, timestamp, feedback"
QUEUE_COND = "(prediction='FRAUD' OR risk IN ('Medium','High'))"


def init_db():
    with db() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS predictions (
            id TEXT PRIMARY KEY, amount REAL, prediction TEXT, probability REAL,
            risk TEXT, timestamp TEXT, features TEXT, feedback TEXT)""")
        have = {r[1] for r in c.execute("PRAGMA table_info(predictions)")}
        for col in ("features", "feedback"):
            if col not in have:
                c.execute(f"ALTER TABLE predictions ADD COLUMN {col} TEXT")


def risk_level(p):
    return "High" if p >= 0.7 else "Medium" if p >= 0.3 else "Low"


def run_model(df):
    """Same preprocessing as training: feature order -> StandardScaler -> XGBoost."""
    X = S["scaler"].transform(pipeline.add_features(df))
    prob = pipeline.apply_cal(S["model"].predict_proba(X)[:, 1], S.get("cal"))
    anom = None
    if S["iso"]:
        try:
            raw = -S["iso"]["model"].score_samples(X)
            anom = np.clip(np.searchsorted(S["iso"]["quantiles"], raw), 0, 100)
        except Exception:
            anom = None
    return X, prob, anom


def explain(X, raw_df, k=5):
    """Top feature contributions (XGBoost SHAP-style, log-odds) for one scaled row."""
    try:
        c = S["model"].get_booster().predict(xgb.DMatrix(X[:1]), pred_contribs=True)[0][:-1]
        order = np.argsort(-np.abs(c))[:k]
        full = pipeline.add_features(raw_df)
        return [{"feature": MODEL_FEATURES[i], "value": round(float(full.iloc[0][MODEL_FEATURES[i]]), 4),
                 "impact": round(float(c[i]), 3)} for i in order]
    except Exception:
        return []


def build_rows(df, probs, anom=None):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    thr = S["threshold"]
    out = []
    for i, (amt, p) in enumerate(zip(df["Amount"].values, probs)):
        p = float(p)
        r = {"id": "TX-" + uuid.uuid4().hex[:10].upper(), "amount": round(float(amt), 2),
             "prediction": "FRAUD" if p >= thr else "NORMAL",
             "probability": round(p * 100, 2), "risk": risk_level(p), "timestamp": ts}
        if anom is not None:
            r["anomaly"] = int(anom[i])
        out.append(r)
    return out


def store(rows, df):
    feats = df[FEATURES].astype(float).round(6).values.tolist()
    with db() as c:
        c.executemany("INSERT INTO predictions (id,amount,prediction,probability,risk,timestamp,features) "
                      "VALUES (?,?,?,?,?,?,?)",
                      [(r["id"], r["amount"], r["prediction"], r["probability"], r["risk"],
                        r["timestamp"], json.dumps(f)) for r, f in zip(rows, feats)])
        c.execute("""DELETE FROM predictions WHERE id NOT IN
                     (SELECT id FROM predictions ORDER BY timestamp DESC, rowid DESC LIMIT 20000)""")


def admin_only(f):
    @wraps(f)
    def wrapper(*a, **k):
        if PUBLIC_DEMO:
            return jsonify(error="This action is disabled in the public demo."), 403
        return f(*a, **k)
    return wrapper


@app.route("/healthz")
def healthz():
    return jsonify(status="ok")


@app.errorhandler(413)
def too_large(_):
    return jsonify(error="File too large (max 10 MB)."), 413


@app.errorhandler(Exception)
def generic(e):
    code = getattr(e, "code", 500)
    if isinstance(code, int) and code < 500:
        return jsonify(error=getattr(e, "description", "Bad request")), code
    app.logger.exception("Unhandled error")
    return jsonify(error="Something went wrong. Please check your input and try again."), 500


@app.route("/")
def index():
    return render_template("index.html", features=FEATURES)


@app.route("/api/samples")
def samples():
    return jsonify(S["samples"])


@app.route("/api/predict", methods=["POST"])
def predict():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify(error="Invalid request body."), 400
    vals, missing = {}, []
    for f in FEATURES:
        try:
            v = float(data.get(f))
            if not np.isfinite(v):
                raise ValueError
            vals[f] = v
        except (TypeError, ValueError):
            missing.append(f)
    if missing:
        return jsonify(error="Missing or invalid values: " + ", ".join(missing)), 400
    df = pd.DataFrame([vals])
    with LOCK:
        X, prob, anom = run_model(df)
        row = build_rows(df, prob, anom)[0]
        row["explanation"] = explain(X, df)
        store([row], df)
    row["unusual"] = bool(anom is not None and anom[0] >= 99)
    row["threshold"] = S["threshold"]
    return jsonify(row)


@app.route("/api/predict_csv", methods=["POST"])
def predict_csv():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="No file uploaded."), 400
    if not f.filename.lower().endswith(".csv"):
        return jsonify(error="Please upload a .csv file."), 400
    try:
        df = pd.read_csv(io.BytesIO(f.read()))
    except Exception:
        return jsonify(error="Could not read the CSV file."), 400
    if df.empty:
        return jsonify(error="The CSV file is empty."), 400
    df.columns = [str(c).strip() for c in df.columns]
    miss = [c for c in FEATURES if c not in df.columns]
    if miss:
        return jsonify(error="Missing required columns: " + ", ".join(miss)), 400
    if len(df) > MAX_ROWS:
        return jsonify(error=f"Too many rows (max {MAX_ROWS})."), 400
    df = df[FEATURES].apply(pd.to_numeric, errors="coerce").replace([np.inf, -np.inf], np.nan)
    valid = df.dropna().reset_index(drop=True)
    skipped = int(len(df) - len(valid))
    if valid.empty:
        return jsonify(error="No valid rows found in the CSV."), 400
    with LOCK:
        _, prob, anom = run_model(valid)
        rows = build_rows(valid, prob, anom)
        store(rows, valid)
    fraud = sum(r["prediction"] == "FRAUD" for r in rows)
    return jsonify(total=len(rows), fraud=fraud, normal=len(rows) - fraud,
                   fraud_pct=round(100 * fraud / len(rows), 2), skipped=skipped, results=rows)


@app.route("/api/stats")
def stats():
    with db() as c:
        total, fraud = c.execute(
            "SELECT COUNT(*), COALESCE(SUM(prediction='FRAUD'),0) FROM predictions").fetchone()
        recent = [dict(r) for r in c.execute(
            f"SELECT {COLS} FROM predictions ORDER BY timestamp DESC, rowid DESC LIMIT 8")]
        top = [dict(r) for r in c.execute(
            f"SELECT {COLS} FROM predictions ORDER BY probability DESC LIMIT 5")]
        trend = [dict(r) for r in c.execute(
            """SELECT substr(timestamp,1,10) d, COUNT(*) n, SUM(prediction='FRAUD') f
               FROM predictions GROUP BY d ORDER BY d DESC LIMIT 14""")][::-1]
        open_q = c.execute(f"SELECT COUNT(*) FROM predictions WHERE {QUEUE_COND} AND feedback IS NULL").fetchone()[0]
    return jsonify(total=total, fraud=fraud, normal=total - fraud,
                   rate=round(100 * fraud / total, 2) if total else 0,
                   recent=recent, top=top, trend=trend, open_queue=open_q)


SORTABLE = {"id", "amount", "prediction", "probability", "risk", "timestamp"}


@app.route("/api/history")
def history():
    q = request.args.get("q", "").strip()
    pred = request.args.get("prediction", "")
    risk = request.args.get("risk", "")
    sort = request.args.get("sort", "timestamp")
    sort = sort if sort in SORTABLE else "timestamp"
    direction = "ASC" if request.args.get("dir") == "asc" else "DESC"
    try:
        size = min(max(int(request.args.get("size", 10)), 5), 100)
        page = max(int(request.args.get("page", 1)), 1)
    except ValueError:
        size, page = 10, 1
    where, args = "WHERE 1=1", []
    if q:
        where += " AND (id LIKE ? OR CAST(amount AS TEXT) LIKE ?)"
        args += [f"%{q}%", f"%{q}%"]
    if pred in ("FRAUD", "NORMAL"):
        where += " AND prediction=?"; args.append(pred)
    if risk in ("Low", "Medium", "High"):
        where += " AND risk=?"; args.append(risk)
    with db() as c:
        total = c.execute(f"SELECT COUNT(*) FROM predictions {where}", args).fetchone()[0]
        rows = [dict(r) for r in c.execute(
            f"SELECT {COLS} FROM predictions {where} ORDER BY {sort} {direction}, rowid DESC LIMIT ? OFFSET ?",
            args + [size, (page - 1) * size])]
    return jsonify(items=rows, total=total, page=page, size=size)


@app.route("/api/history/clear", methods=["POST"])
@admin_only
def clear_history():
    with db() as c:
        c.execute("DELETE FROM predictions")
    return jsonify(ok=True)


@app.route("/api/metrics")
def metrics():
    return jsonify({**S["metrics"], "threshold": S["threshold"], "anomaly_available": S["iso"] is not None})


@app.route("/api/threshold", methods=["POST"])
@admin_only
def set_threshold():
    d = request.get_json(silent=True) or {}
    try:
        t = float(d.get("threshold"))
    except (TypeError, ValueError):
        return jsonify(error="Invalid threshold."), 400
    if not 0.05 <= t <= 0.95:
        return jsonify(error="Threshold must be between 0.05 and 0.95."), 400
    t = round(t, 2)
    with LOCK:
        json.dump({"threshold": t}, open(MODEL_DIR / "config.json", "w"))
        S["threshold"] = t
        row = next((r for r in S["metrics"]["threshold_curve"] if abs(r["t"] - t) < 1e-9), None)
        if row:  # keep headline metrics consistent with the applied threshold
            S["metrics"].update(precision=row["precision"], recall=row["recall"], f1=row["f1"],
                                threshold=t, confusion_matrix={k: row[k] for k in ("tn", "fp", "fn", "tp")})
            json.dump(S["metrics"], open(MODEL_DIR / "metrics.json", "w"))
    return jsonify(ok=True, threshold=t)


@app.route("/api/feedback", methods=["POST"])
def feedback():
    d = request.get_json(silent=True) or {}
    v = d.get("value")
    if v not in ("correct", "wrong", "none") or not isinstance(d.get("id"), str):
        return jsonify(error="Invalid feedback."), 400
    with db() as c:
        c.execute("UPDATE predictions SET feedback=? WHERE id=?", (None if v == "none" else v, d["id"]))
    return jsonify(ok=True)


@app.route("/api/status")
def status():
    with db() as c:
        fb = dict(c.execute("SELECT COALESCE(feedback,'none') k, COUNT(*) n FROM predictions GROUP BY k").fetchall())
    return jsonify(correct=fb.get("correct", 0), wrong=fb.get("wrong", 0),
                   dataset_available=pipeline.DATA.exists(),
                   trained_at=S["metrics"].get("trained_at"), version=S["metrics"].get("version"),
                   candidate_pending=(CAND / "metrics.json").exists(),
                   feedback_rows_used=S["metrics"].get("feedback_rows_used", 0))


def psi(values, ref):
    edges = np.array(ref["edges"])
    cnt = np.bincount(np.searchsorted(edges, values, side="right"), minlength=len(edges) + 1)
    a = np.clip(cnt / cnt.sum(), 1e-4, None)
    e = np.clip(np.array(ref["expected"]), 1e-4, None)
    return float(np.sum((a - e) * np.log(a / e)))


@app.route("/api/drift")
def drift():
    """Population Stability Index per input feature: recent predictions vs training data."""
    with db() as c:
        rows = c.execute("SELECT features, prediction FROM predictions WHERE features IS NOT NULL "
                         "ORDER BY rowid DESC LIMIT 500").fetchall()
    n = len(rows)
    if not S.get("drift_ref"):
        return jsonify(enough=False, n=n, reason="Drift reference missing. Run python train.py.")
    if n < 100:
        return jsonify(enough=False, n=n, need=100)
    X = np.array([json.loads(r["features"]) for r in rows], dtype=float)
    p = {f: psi(X[:, i], S["drift_ref"][f]) for i, f in enumerate(FEATURES) if f in S["drift_ref"]}
    top = sorted(p.items(), key=lambda kv: -kv[1])[:5]
    high = sum(v > 0.25 for v in p.values()); mod = sum(v > 0.1 for v in p.values())
    status = "Significant drift" if high >= 1 else "Moderate drift" if mod >= 3 else "Stable"
    m = S["metrics"]
    return jsonify(enough=True, n=n, status=status, features_over_0_1=mod, features_over_0_25=high,
                   top=[{"feature": f, "psi": round(v, 3)} for f, v in top],
                   baseline_fraud_pct=round(m["test_fraud"] / m["test_size"] * 100, 3),
                   recent_fraud_pct=round(100 * sum(r["prediction"] == "FRAUD" for r in rows) / n, 2))


def snapshot_live(prune=True):
    """Save the live model files as a version so it can be restored later."""
    vid = S["metrics"].get("version") or "v" + datetime.now().strftime("%Y%m%d_%H%M%S")
    d = VERSIONS / vid
    d.mkdir(parents=True, exist_ok=True)
    for f in pipeline.ARTIFACTS:
        if (MODEL_DIR / f).exists():
            shutil.copy2(MODEL_DIR / f, d / f)
    if prune:
        for old in sorted([x for x in VERSIONS.iterdir() if x.is_dir()], reverse=True)[8:]:
            shutil.rmtree(old, ignore_errors=True)


def install(src):
    for f in pipeline.ARTIFACTS:
        if (src / f).exists():
            shutil.copy2(src / f, MODEL_DIR / f)
    load_state()


def gate(cand, live):
    checks = [("PR-AUC", live["pr_auc"], cand["pr_auc"], cand["pr_auc"] >= live["pr_auc"] - 0.01),
              ("ROC-AUC", live["roc_auc"], cand["roc_auc"], cand["roc_auc"] >= live["roc_auc"] - 0.005)]
    return [{"name": n, "live": round(a, 4), "candidate": round(b, 4), "ok": bool(ok)} for n, a, b, ok in checks]


@app.route("/api/retrain", methods=["POST"])
@admin_only
def retrain():
    """Train a candidate on the same test split; promote only if it passes the gate."""
    if not pipeline.DATA.exists():
        return jsonify(error="Training dataset not found. Place creditcard.csv in the data/ folder."), 400
    if not RETRAIN_LOCK.acquire(blocking=False):
        return jsonify(error="A retraining job is already running."), 409
    try:
        with db() as c:
            rows = c.execute("SELECT features, prediction, feedback FROM predictions "
                             "WHERE features IS NOT NULL AND feedback IN ('correct','wrong')").fetchall()
        extra = None
        if rows:
            Xe = pd.DataFrame([json.loads(r["features"]) for r in rows], columns=FEATURES)
            ye = [(1 if r["prediction"] == "FRAUD" else 0) if r["feedback"] == "correct"
                  else (0 if r["prediction"] == "FRAUD" else 1) for r in rows]
            extra = (Xe, ye)
        shutil.rmtree(CAND, ignore_errors=True)
        try:
            m = pipeline.train_and_save(extra=extra, full=False, out=CAND)  # live model untouched while training
        except Exception:
            app.logger.exception("Retrain failed")
            shutil.rmtree(CAND, ignore_errors=True)
            return jsonify(error="Retraining failed. The current model was kept."), 500
        checks = gate(m, S["metrics"])
        passed = all(c["ok"] for c in checks)
        if passed:
            with LOCK:
                snapshot_live()
                install(CAND)
            shutil.rmtree(CAND, ignore_errors=True)
        return jsonify(ok=True, promoted=passed, used=len(rows), checks=checks, version=m["version"],
                       candidate={k: m[k] for k in ("precision", "recall", "f1", "roc_auc", "pr_auc")})
    finally:
        RETRAIN_LOCK.release()


@app.route("/api/promote_candidate", methods=["POST"])
@admin_only
def promote_candidate():
    if not (CAND / "metrics.json").exists():
        return jsonify(error="No candidate model is waiting."), 400
    with LOCK:
        snapshot_live()
        install(CAND)
    shutil.rmtree(CAND, ignore_errors=True)
    return jsonify(ok=True, version=S["metrics"].get("version"))


@app.route("/api/versions")
def versions():
    out = []
    if VERSIONS.exists():
        for d in sorted([x for x in VERSIONS.iterdir() if x.is_dir()], reverse=True):
            try:
                m = json.load(open(d / "metrics.json"))
                out.append({"id": d.name, "trained_at": m.get("trained_at"), "precision": m["precision"],
                            "recall": m["recall"], "pr_auc": m["pr_auc"],
                            "feedback_rows_used": m.get("feedback_rows_used", 0)})
            except Exception:
                continue
    return jsonify(current=S["metrics"].get("version"), versions=out)


@app.route("/api/rollback", methods=["POST"])
@admin_only
def rollback():
    vid = (request.get_json(silent=True) or {}).get("id", "")
    if not isinstance(vid, str) or not re.fullmatch(r"v\d{8}_\d{6}", vid) or not (VERSIONS / vid / "metrics.json").exists():
        return jsonify(error="Unknown version."), 400
    with LOCK:
        snapshot_live(prune=False)  # keep the current model restorable too
        install(VERSIONS / vid)
    return jsonify(ok=True, version=vid)


@app.route("/api/queue")
def queue():
    status = "reviewed" if request.args.get("status") == "reviewed" else "open"
    cond = "feedback IS NULL" if status == "open" else "feedback IS NOT NULL"
    with db() as c:
        rows = [dict(r) for r in c.execute(
            f"SELECT {COLS}, ROUND(amount*probability/100.0, 2) AS expected_loss FROM predictions "
            f"WHERE {QUEUE_COND} AND {cond} ORDER BY expected_loss DESC, probability DESC LIMIT 100")]
        n_open = c.execute(f"SELECT COUNT(*) FROM predictions WHERE {QUEUE_COND} AND feedback IS NULL").fetchone()[0]
        n_rev = c.execute(f"SELECT COUNT(*) FROM predictions WHERE {QUEUE_COND} AND feedback IS NOT NULL").fetchone()[0]
    return jsonify(items=rows, open=n_open, reviewed=n_rev)


@app.route("/api/transaction/<tid>")
def transaction(tid):
    if not re.fullmatch(r"TX-[0-9A-F]{10}", tid):
        return jsonify(error="Invalid transaction ID."), 400
    with db() as c:
        r = c.execute(f"SELECT {COLS}, features FROM predictions WHERE id=?", (tid,)).fetchone()
    if not r:
        return jsonify(error="Transaction not found."), 404
    out = {k: r[k] for k in r.keys() if k != "features"}
    out.update(explanation=[], anomaly=None, unusual=False)
    if r["features"]:
        df = pd.DataFrame([json.loads(r["features"])], columns=FEATURES)
        with LOCK:
            X, _, anom = run_model(df)
            out["explanation"] = explain(X, df)
        if anom is not None:
            out["anomaly"] = int(anom[0]); out["unusual"] = bool(anom[0] >= 99)
    return jsonify(out)


load_state()
init_db()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5000)), debug=False)
