"""Training pipeline (mirrors the reference notebook, extended with evaluation extras).
Usage: place creditcard.csv in data/ then run: python train.py
"""
import json
import joblib
import numpy as np
import pandas as pd
from datetime import datetime
from pathlib import Path
from sklearn.ensemble import IsolationForest, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split, StratifiedKFold, cross_validate, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import (precision_recall_curve, accuracy_score, precision_score, recall_score, f1_score,
                             roc_auc_score, average_precision_score, roc_curve, confusion_matrix, brier_score_loss)
from xgboost import XGBClassifier

BASE = Path(__file__).parent
DATA = BASE / "data" / "creditcard.csv"
OUT = BASE / "model"
try:  # optional challenger model; the project works without it
    from lightgbm import LGBMClassifier
except Exception:
    LGBMClassifier = None

ARTIFACTS = ["xgb_model.json", "xgb_model.joblib", "scaler.joblib", "anomaly.joblib",
             "calibration.json", "drift_ref.json", "metrics.json"]  # files that make up one model version
BINS = [0, .01, .05, .1, .25, .5, .75, .9, 1.0001]
FEATURES = ["Time"] + [f"V{i}" for i in range(1, 29)] + ["Amount"]


MODEL_FEATURES = FEATURES + ["hour", "log_amount"]
# "baseline" = the notebook's RandomizedSearchCV result; "improved" = larger model chosen by 5-fold CV
PARAMS = {
    "baseline": dict(subsample=0.6, reg_lambda=1.5, reg_alpha=0.01, n_estimators=200, max_depth=3,
                     learning_rate=0.05, gamma=0.1, colsample_bytree=1.0),
    "improved": dict(subsample=0.8, reg_lambda=1.0, reg_alpha=0.01, n_estimators=400, max_depth=4,
                     learning_rate=0.05, gamma=0.0, colsample_bytree=0.8, min_child_weight=1),
}


def make_model(kind="improved"):
    return XGBClassifier(**PARAMS[kind], random_state=42, eval_metric="logloss")


def add_features(d):
    """Raw 30 inputs -> model features (adds hour of day and log amount). Used in training AND serving."""
    d = d[FEATURES].astype(float).copy()
    d["hour"] = (d["Time"] // 3600) % 24
    d["log_amount"] = np.log1p(d["Amount"].clip(lower=0))
    return d[MODEL_FEATURES]


def _logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def apply_cal(p, cal):
    """Platt scaling stored as plain JSON coefficients (portable across versions)."""
    if not cal or not cal.get("used"):
        return p
    return 1 / (1 + np.exp(-(cal["a"] * _logit(p) + cal["b"])))


def reliability(y, p):
    rows, ece = [], 0.0
    for lo, hi in zip(BINS[:-1], BINS[1:]):
        m = (p >= lo) & (p < hi)
        if m.sum():
            rows.append({"lo": lo, "hi": min(hi, 1.0), "n": int(m.sum()),
                         "pred": float(p[m].mean()), "obs": float(y[m].mean())})
            ece += m.sum() / len(p) * abs(p[m].mean() - y[m].mean())
    return rows, float(ece)


def temporal_eval(df):
    """Train on the earliest 80% of transactions (by Time), test on the latest 20%."""
    d = df.sort_values("Time").reset_index(drop=True)
    cut = int(len(d) * 0.8)
    tr, te = d.iloc[:cut], d.iloc[cut:]
    sc = StandardScaler()
    m = make_model().fit(sc.fit_transform(add_features(tr)), tr["Class"])
    p = m.predict_proba(sc.transform(add_features(te)))[:, 1]
    return {**scores(te["Class"].values, p, 0.5), "train_size": int(cut), "test_size": int(len(te)),
            "test_fraud": int(te["Class"].sum())}


def get_threshold():
    try:
        return float(json.load(open(OUT / "config.json"))["threshold"])
    except Exception:
        return 0.5


def scores(y, prob, thr=0.5):
    pred = (prob >= thr).astype(int)
    return {"accuracy": float(accuracy_score(y, pred)),
            "precision": float(precision_score(y, pred, zero_division=0)),
            "recall": float(recall_score(y, pred)), "f1": float(f1_score(y, pred)),
            "roc_auc": float(roc_auc_score(y, prob)),
            "pr_auc": float(average_precision_score(y, prob))}


def drift_reference(X):
    ref = {}
    for f in FEATURES:
        edges = np.unique(np.percentile(X[f], np.linspace(0, 100, 11)[1:-1]))
        cnt, _ = np.histogram(X[f], bins=np.concatenate([[-np.inf], edges, [np.inf]]))
        ref[f] = {"edges": edges.tolist(), "expected": (cnt / cnt.sum()).tolist()}
    return ref


def train_and_save(extra=None, full=True, out=OUT):
    """extra=(X_df, y_array): analyst-confirmed rows appended to the TRAIN split only.
    full=False skips cross-validation / model comparison (keeps previous values)."""
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    df = pd.read_csv(DATA)
    df.drop_duplicates(inplace=True)
    X, y = df[FEATURES], df["Class"]
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y)
    n_extra = 0
    if extra is not None and len(extra[1]):
        X_train = pd.concat([X_train, extra[0][FEATURES]], ignore_index=True)
        y_train = np.concatenate([y_train.values, np.asarray(extra[1])])
        n_extra = len(extra[1])

    scaler = StandardScaler()
    Xs = scaler.fit_transform(add_features(X_train))
    Xt = scaler.transform(add_features(X_test))
    model = make_model()
    model.fit(Xs, y_train)
    prob_raw = model.predict_proba(Xt)[:, 1]

    # Out-of-fold train predictions -> (a) Platt calibration, (b) F1-optimal decision threshold.
    # The test set is never used to choose either.
    oof = cross_val_predict(make_model(), Xs, y_train, cv=StratifiedKFold(5, shuffle=True, random_state=42),
                            method="predict_proba")[:, 1]
    pr_, rc_, th_ = precision_recall_curve(y_train, oof)
    f1_ = 2 * pr_ * rc_ / (pr_ + rc_ + 1e-12)
    rec_thr = float(np.clip(round(float(th_[int(np.nanargmax(f1_[:-1]))]), 2), 0.05, 0.95))
    lr = LogisticRegression(C=1e6, max_iter=1000).fit(_logit(oof).reshape(-1, 1), y_train)
    cal = {"a": float(lr.coef_[0][0]), "b": float(lr.intercept_[0]), "used": True}
    yt0 = y_test.values
    prob_cal = apply_cal(prob_raw, cal)
    bins_raw, ece_raw = reliability(yt0, prob_raw)
    bins_cal, ece_cal = reliability(yt0, prob_cal)
    brier_raw, brier_cal = float(brier_score_loss(yt0, prob_raw)), float(brier_score_loss(yt0, prob_cal))
    cal["used"] = bool(brier_cal <= brier_raw)  # only apply if it really improves the Brier score
    prob = prob_cal if cal["used"] else prob_raw
    calibration = {"used": cal["used"], "brier_raw": brier_raw, "brier_cal": brier_cal,
                   "ece_raw": ece_raw, "ece_cal": ece_cal, "bins_raw": bins_raw, "bins_cal": bins_cal}
    thr = rec_thr if (full and out == OUT) else get_threshold()
    pred = (prob >= thr).astype(int)
    tn, fp, fn, tp = confusion_matrix(y_test, pred, labels=[0, 1]).ravel()
    fpr, tpr, _ = roc_curve(y_test, prob)
    idx = np.linspace(0, len(fpr) - 1, min(200, len(fpr))).astype(int)
    amt = X_test["Amount"].values
    yt = y_test.values

    curve = []
    for t in np.round(np.arange(0.05, 0.9501, 0.01), 2):
        t = float(t)
        p = (prob >= t).astype(int)
        a, b, c, d = confusion_matrix(yt, p, labels=[0, 1]).ravel()
        curve.append({"t": t, "tp": int(d), "fp": int(b), "fn": int(c), "tn": int(a),
                      "precision": float(precision_score(yt, p, zero_division=0)),
                      "recall": float(recall_score(yt, p)), "f1": float(f1_score(yt, p, zero_division=0)),
                      "fn_amount": float(amt[(yt == 1) & (p == 0)].sum()),
                      "flagged": int(p.sum())})

    # Isolation Forest: secondary anomaly score (percentile vs training data); XGBoost stays primary
    iso = IsolationForest(n_estimators=100, random_state=42, n_jobs=-1).fit(Xs)
    q = np.percentile(-iso.score_samples(Xs), np.linspace(0, 100, 101))
    pct = np.clip(np.searchsorted(q, -iso.score_samples(Xt)), 0, 100)
    unusual = pct >= 99
    missed = (yt == 1) & (pred == 0)
    or_pred = ((pred == 1) | unusual).astype(int)
    anomaly = {"roc_auc": float(roc_auc_score(yt, pct)),
               "missed_frauds": int(missed.sum()), "missed_caught": int((missed & unusual).sum()),
               "normal_flag_rate": float(unusual[yt == 0].mean()),
               "combined_precision": float(precision_score(yt, or_pred, zero_division=0)),
               "combined_recall": float(recall_score(yt, or_pred))}

    prev = {}
    try:
        prev = json.load(open(OUT / "metrics.json"))
    except Exception:
        pass
    cv, cv_base, comparison, temporal = (prev.get(k) for k in ("cv", "cv_baseline", "comparison", "temporal"))
    if full:
        scoring = {"precision": "precision", "recall": "recall", "f1": "f1", "roc_auc": "roc_auc",
                   "pr_auc": "average_precision"}
        folds = StratifiedKFold(5, shuffle=True, random_state=42)

        def cvrun(kind, data):
            res = cross_validate(make_pipeline(StandardScaler(), make_model(kind)), data, y, cv=folds, scoring=scoring)
            return {k: {"mean": float(res[f"test_{k}"].mean()), "std": float(res[f"test_{k}"].std())}
                    for k in scoring}
        cv = cvrun("improved", add_features(X))
        cv_base = cvrun("baseline", X)

        sc0 = StandardScaler()  # notebook baseline: raw 30 features, original tuned parameters
        base_p = make_model("baseline").fit(sc0.fit_transform(X_train[FEATURES]), y_train) \
            .predict_proba(sc0.transform(X_test[FEATURES]))[:, 1]
        comparison = [{"model": "XGBoost (notebook baseline)", **scores(yt, base_p, 0.5)},
                      {"model": "XGBoost (improved, primary)", **scores(yt, prob_raw, 0.5)}]
        challengers = [("Logistic Regression", LogisticRegression(max_iter=1000, class_weight="balanced", random_state=42)),
                       ("Random Forest", RandomForestClassifier(n_estimators=100, class_weight="balanced",
                                                                random_state=42, n_jobs=-1))]
        if LGBMClassifier is not None:
            challengers.append(("LightGBM (challenger)", LGBMClassifier(
                n_estimators=500, learning_rate=0.03, num_leaves=15, subsample=0.8, subsample_freq=1,
                colsample_bytree=0.7, random_state=42, n_jobs=1, verbose=-1)))
        for name, clf in challengers:
            comparison.append({"model": name, **scores(yt, clf.fit(Xs, y_train).predict_proba(Xt)[:, 1], 0.5)})
        temporal = temporal_eval(df)

    imp = sorted(zip(MODEL_FEATURES, model.feature_importances_), key=lambda x: -x[1])[:10]
    metrics = {**scores(yt, prob, thr), "threshold": thr, "recommended_threshold": rec_thr,
               "confusion_matrix": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
               "roc_curve": {"fpr": fpr[idx].tolist(), "tpr": tpr[idx].tolist()},
               "threshold_curve": curve, "anomaly": anomaly, "cv": cv, "cv_baseline": cv_base,
               "comparison": comparison, "temporal": temporal, "calibration": calibration,
               "top_features": [{"feature": f, "importance": float(v)} for f, v in imp],
               "engineered_features": ["hour", "log_amount"],
               "test_size": int(len(yt)), "train_size": int(len(y_train)), "test_fraud": int(yt.sum()),
               "feedback_rows_used": n_extra,
               "trained_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
               "version": "v" + datetime.now().strftime("%Y%m%d_%H%M%S")}

    joblib.dump(model, out / "xgb_model.joblib")
    model.save_model(str(out / "xgb_model.json"))  # version-portable native format
    joblib.dump(scaler, out / "scaler.joblib")
    joblib.dump({"model": iso, "quantiles": q}, out / "anomaly.joblib")
    json.dump(cal, open(out / "calibration.json", "w"))
    json.dump(drift_reference(X_train), open(out / "drift_ref.json", "w"))
    json.dump(metrics, open(out / "metrics.json", "w"))
    if out == OUT:
        json.dump({"features": FEATURES, "model_features": MODEL_FEATURES}, open(OUT / "features.json", "w"))
        if full or not (OUT / "config.json").exists():
            json.dump({"threshold": thr}, open(OUT / "config.json", "w"))

    if full and out == OUT:  # small demo sample from the held-out test set
        s = pd.concat([X_test[y_test == 1].head(5), X_test[y_test == 0].head(5)])
        s.to_csv(BASE / "data" / "sample_transactions.csv", index=False)
        s.to_csv(BASE / "static" / "sample_transactions.csv", index=False)
        json.dump({"fraud": s.iloc[0].to_dict(), "normal": s.iloc[5].to_dict()},
                  open(OUT / "samples.json", "w"))
    return metrics


if __name__ == "__main__":
    m = train_and_save(full=True)
    f = lambda d: {k: round(v["mean"], 4) for k, v in d.items()}
    print("Test @thr", m["threshold"], {k: round(v, 4) for k, v in m.items() if isinstance(v, float)})
    print("CV improved:", f(m["cv"])); print("CV baseline:", f(m["cv_baseline"]))
    print("Comparison:", [(c["model"], round(c["recall"], 3), round(c["precision"], 3), round(c["pr_auc"], 4)) for c in m["comparison"]])
    c = m["calibration"]
    print("Calibration used:", c["used"], "Brier", round(c["brier_raw"], 6), "->", round(c["brier_cal"], 6))
    print("Temporal:", {k: round(v, 4) if isinstance(v, float) else v for k, v in m["temporal"].items()})
