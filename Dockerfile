# Tiny, dependency-free image — just Python's standard library.
FROM python:3.12-alpine

WORKDIR /app
COPY server.py .
COPY catalog/ ./catalog/
COPY static/ ./static/

# Data lives in a volume so it survives container rebuilds/updates.
VOLUME ["/app/data"]

ENV PORT=8000
EXPOSE 8000

CMD ["python3", "server.py"]
