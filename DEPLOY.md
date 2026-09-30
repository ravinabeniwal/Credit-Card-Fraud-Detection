# Deploy FraudGuard (Render, free tier)

1. Put the project on GitHub
   ```
   cd fraud-detection-app
   git init && git add . && git commit -m "FraudGuard"
   git branch -M main
   git remote add origin https://github.com/<you>/fraudguard.git
   git push -u origin main
   ```
   (`data/creditcard.csv` is git-ignored; the trained `model/` files ARE committed and are all the app needs.)

2. On https://render.com: New + → Blueprint → pick the repo → Apply. It reads `render.yaml`.
   Or New + → Web Service, then set:
   - Build command: `pip install -r requirements.txt`
   - Start command: `gunicorn app:app --workers 1 --threads 4 --timeout 120 --bind 0.0.0.0:$PORT`
   - Health check path: `/healthz`
   - Environment: `PYTHON_VERSION=3.12.3`, `PUBLIC_DEMO=1`

3. Wait for the first build (a few minutes). Your URL is `https://<name>.onrender.com`.

## Good to know
* `PUBLIC_DEMO=1` disables threshold changes, retraining, rollback and clear-history for visitors.
  Remove it (or set 0) only for private use.
* Free instances sleep after ~15 min idle (first visit takes ~30-60 s) and the disk is temporary, so
  history resets on restart/redeploy. Use a paid instance + persistent disk for permanent history.
* All visitors share one history table (only anonymized model features and amounts are stored).
* Keep `scikit-learn`/`xgboost` versions pinned: the saved scaler and model must be loaded by the
  same versions that trained them. After changing versions, run `python train.py` and commit `model/`.
