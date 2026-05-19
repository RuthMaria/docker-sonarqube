#!/usr/bin/env bash
set -euo pipefail

if [ -z "${SONAR_TOKEN:-}" ]; then
  echo "Defina o token: export SONAR_TOKEN=\"seu_token\""
  exit 1
fi

AIDER_DIR="${AIDER_DIR:-/c/Users/Ruth/Downloads/projetos/aider}"
SONAR_URL="${SONAR_HOST_URL:-http://host.docker.internal:9002}"

MSYS_NO_PATHCONV=1 docker run --rm \
  -e SONAR_HOST_URL="$SONAR_URL" \
  -e SONAR_TOKEN \
  -v "${AIDER_DIR}:/usr/src" \
  sonarsource/sonar-scanner-cli \
  -Dsonar.projectKey=testando-sonarqube \
  -Dsonar.projectName=aider \
  -Dsonar.sources=. \
  -Dsonar.python.version=3.12 \
  -Dsonar.exclusions=**/tests/**,**/scripts/**,**/website/**,**/__pycache__/**,**/.git/**,**/.venv/**,**/node_modules/**
