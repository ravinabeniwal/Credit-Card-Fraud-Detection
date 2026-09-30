# FraudGuard – Credit Card Fraud Detection (XGBoost + Flask)

## Run
```
pip install -r requirements.txt
python app.py            # http://127.0.0.1:5000
```
Retrain from scratch (needs `data/creditcard.csv`, the public European card dataset): `python train.py`
Tests: `pip install -r requirements-dev.txt && pytest -q`

## What it does
Scores single transactions and CSV batches with a tuned XGBoost model (primary), explains each score,
flags cost-effective reviews, tracks history, and supports analyst feedback, safe retraining and rollback.

## ML pipeline
Dataset (283,726 rows after de-duplication, 473 fraud) → 80/20 stratified split → engineered features
(`hour`, `log_amount`) → StandardScaler (fit on train only) → XGBoost. Decision threshold and optional
Platt calibration are chosen from out-of-fold *training* predictions; the test set is never used for tuning.

## Evaluation shown in the app
Test-set metrics, ROC, confusion matrix · 5-fold CV vs the notebook baseline · time-based split ·
Logistic Regression / Random Forest / LightGBM (optional) comparison · calibration table ·
threshold and cost tuning · Isolation Forest anomaly signal (advisory) · PSI drift check.

## Limits (be upfront about these)
* Only ~473 frauds: single-split recall moves ~1 point per missed fraud. Prefer CV numbers.
* V1–V28 are anonymized PCA features from a 2-day 2013 sample; users cannot type meaningful values.
* Gains over the notebook model are modest; the dataset appears close to its ceiling for tree models.
* Local demo: no authentication, SQLite storage, Flask development server.

## Synopsis
**Problem.** Fraud is rare (0.17%) and costly; imbalanced data, black-box models and changing patterns make
detection hard. **Objective.** Turn a notebook model into an explainable, cost-aware fraud detection application.
**Method.** Tuned XGBoost with feature engineering, cross-validated comparison against other models, calibrated and
threshold-tuned decisions, per-prediction explanations, review queue, drift monitoring, gated retraining with versions.
**Outcome.** See the Model Performance page for live numbers computed from the trained model.
