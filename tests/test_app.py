"""Run with: pytest -q   (needs the trained model in model/ and no dataset)."""
import io, json, sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app as appmod  # noqa: E402

BASE = Path(__file__).resolve().parent.parent
SAMPLES = json.load(open(BASE / "model" / "samples.json"))
SAMPLE_CSV = BASE / "data" / "sample_transactions.csv"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(appmod, "DB", tmp_path / "test.db")  # never touch the real history
    appmod.init_db()
    return appmod.app.test_client()


def upload(client, data, name="t.csv"):
    return client.post("/api/predict_csv", data={"file": (io.BytesIO(data), name)}, content_type="multipart/form-data")


def test_index_and_static(client):
    assert client.get("/").status_code == 200
    assert client.get("/static/app.js").status_code == 200


def test_sample_predictions_are_real(client):
    assert client.post("/api/predict", json=SAMPLES["fraud"]).get_json()["prediction"] == "FRAUD"
    assert client.post("/api/predict", json=SAMPLES["normal"]).get_json()["prediction"] == "NORMAL"


def test_api_matches_direct_model_computation(client):
    """Serving preprocessing must equal training preprocessing (feature order, engineering, scaler)."""
    df = pd.DataFrame([SAMPLES["fraud"]])
    X = appmod.S["scaler"].transform(appmod.pipeline.add_features(df))
    direct = float(appmod.pipeline.apply_cal(appmod.S["model"].predict_proba(X)[:, 1], appmod.S.get("cal"))[0])
    api = client.post("/api/predict", json=SAMPLES["fraud"]).get_json()["probability"]
    assert abs(api - round(direct * 100, 2)) < 0.01


def test_prediction_fields_and_risk_bands(client):
    r = client.post("/api/predict", json=SAMPLES["fraud"]).get_json()
    assert r["risk"] in ("Low", "Medium", "High") and 0 <= r["probability"] <= 100
    assert r["id"].startswith("TX-") and len(r["explanation"]) == 5
    assert appmod.risk_level(0.1) == "Low" and appmod.risk_level(0.5) == "Medium" and appmod.risk_level(0.9) == "High"


def test_missing_and_invalid_inputs(client):
    assert client.post("/api/predict", json={"Time": 1}).status_code == 400
    bad = dict(SAMPLES["normal"], V1="abc")
    assert client.post("/api/predict", json=bad).status_code == 400
    assert client.post("/api/predict", json=dict(SAMPLES["normal"], V2=float("inf"))).status_code == 400
    assert client.post("/api/predict", data="not json", content_type="text/plain").status_code == 400


def test_csv_batch_and_validation(client):
    r = upload(client, SAMPLE_CSV.read_bytes()).get_json()
    assert r["total"] == 10 and r["fraud"] + r["normal"] == 10 and r["fraud"] >= 1
    assert upload(client, b"a,b\n1,2\n").status_code == 400                  # missing columns
    assert upload(client, b"x", "x.txt").status_code == 400                  # wrong extension
    assert upload(client, b"").status_code == 400                            # empty
    df = pd.read_csv(SAMPLE_CSV).astype(object); df.loc[0, "V3"] = np.nan; df.loc[1, "Amount"] = "oops"
    r = upload(client, df.to_csv(index=False).encode()).get_json()
    assert r["skipped"] == 2 and r["total"] == 8                             # bad rows skipped, no crash


def test_threshold_bounds_and_effect(client):
    assert client.post("/api/threshold", json={"threshold": 2}).status_code == 400
    assert client.post("/api/threshold", json={"threshold": "x"}).status_code == 400
    old = appmod.S["threshold"]
    try:
        client.post("/api/threshold", json={"threshold": 0.95})
        assert client.post("/api/predict", json=SAMPLES["fraud"]).get_json()["threshold"] == 0.95
    finally:  # restore live config/metrics
        client.post("/api/threshold", json={"threshold": old})


def test_history_paging_sorting_filters(client):
    upload(client, SAMPLE_CSV.read_bytes())
    d = client.get("/api/history?size=5&sort=amount&dir=asc").get_json()
    assert d["total"] == 10 and len(d["items"]) == 5
    amounts = [i["amount"] for i in d["items"]]; assert amounts == sorted(amounts)
    assert client.get("/api/history?sort=DROP TABLE").status_code == 200      # unknown sort column is ignored
    fraud = client.get("/api/history?prediction=FRAUD").get_json()
    assert all(i["prediction"] == "FRAUD" for i in fraud["items"])


def test_feedback_queue_and_transaction_detail(client):
    r = client.post("/api/predict", json=SAMPLES["fraud"]).get_json()
    q = client.get("/api/queue").get_json(); assert q["open"] == 1
    assert client.post("/api/feedback", json={"id": r["id"], "value": "correct"}).status_code == 200
    q = client.get("/api/queue").get_json(); assert q["open"] == 0 and q["reviewed"] == 1
    assert client.post("/api/feedback", json={"id": r["id"], "value": "bogus"}).status_code == 400
    t = client.get("/api/transaction/" + r["id"]).get_json(); assert t["id"] == r["id"] and t["explanation"]
    assert client.get("/api/transaction/nope").status_code == 400
    assert client.get("/api/transaction/TX-0000000000").status_code == 404


def test_drift_needs_enough_data(client):
    assert client.get("/api/drift").get_json()["enough"] is False


def test_psi_is_zero_for_reference_like_data():
    ref = appmod.S["drift_ref"]["V1"]
    edges = np.array(ref["edges"]); rng = np.random.default_rng(0)
    same = rng.choice(np.concatenate([[edges[0] - 1], (edges[:-1] + edges[1:]) / 2, [edges[-1] + 1]]), 2000)
    assert appmod.psi(same, ref) < 0.1
    assert appmod.psi(np.full(500, edges[-1] + 100), ref) > 0.25              # everything in the top bin


def test_versions_and_rollback_validation(client):
    assert client.get("/api/versions").status_code == 200
    assert client.post("/api/rollback", json={"id": "../../etc"}).status_code == 400
    assert client.post("/api/promote_candidate").status_code == 400


def test_metrics_are_consistent(client):
    m = client.get("/api/metrics").get_json(); c = m["confusion_matrix"]
    assert c["tp"] + c["fn"] == m["test_fraud"] and sum(c.values()) == m["test_size"]
    assert abs(m["recall"] - c["tp"] / (c["tp"] + c["fn"])) < 1e-6
    assert 0 < m["roc_auc"] <= 1 and 0.05 <= m["recommended_threshold"] <= 0.95


def test_public_demo_blocks_admin_actions(client, monkeypatch):
    monkeypatch.setattr(appmod, "PUBLIC_DEMO", True)
    for url in ("/api/history/clear", "/api/threshold", "/api/retrain", "/api/promote_candidate", "/api/rollback"):
        assert client.post(url, json={}).status_code == 403
    assert client.post("/api/predict", json=SAMPLES["normal"]).status_code == 200  # normal use still works
    assert client.get("/healthz").get_json()["status"] == "ok"
