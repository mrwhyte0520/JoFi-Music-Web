FROM node:22-slim AS frontend
WORKDIR /app/app
COPY app/package.json app/package-lock.json ./
RUN npm install
COPY app/ ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
COPY --from=frontend /app/app/dist ./app/dist
CMD ["python", "server.py"]
