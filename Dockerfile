FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FASTEMBED_CACHE_PATH=/opt/models \
    MODEL_NAME=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN useradd --create-home app && mkdir -p /opt/models && chown app:app /opt/models
USER app

# Le modèle est téléchargé UNE FOIS au build et reste dans l'image :
# le conteneur démarre ensuite sans accès réseau.
# (Si MODEL_NAME change dans docker-compose, refaire un build.)
RUN python -c "import os; from fastembed import TextEmbedding; TextEmbedding(os.environ['MODEL_NAME'], cache_dir=os.environ['FASTEMBED_CACHE_PATH'])"

COPY --chown=app:app app ./app

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
