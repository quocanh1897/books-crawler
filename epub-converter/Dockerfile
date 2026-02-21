FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY convert.py epub_builder.py ./

ENTRYPOINT ["python3", "convert.py"]
