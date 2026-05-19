#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

if (-not $env:SONAR_TOKEN) {
    Write-Error "Defina o token primeiro: `$env:SONAR_TOKEN = 'seu_token'"
    exit 1
}

$AiderDir = if ($env:AIDER_DIR) { $env:AIDER_DIR } else { "C:\Users\Ruth\Downloads\projetos\aider" }
$SonarUrl = if ($env:SONAR_HOST_URL) { $env:SONAR_HOST_URL } else { "http://host.docker.internal:9002" }

if (-not (Test-Path $AiderDir)) {
    Write-Error "Pasta nao encontrada: $AiderDir"
    exit 1
}

docker run --rm `
  -e SONAR_HOST_URL=$SonarUrl `
  -e SONAR_TOKEN=$env:SONAR_TOKEN `
  -v "${AiderDir}:/usr/src" `
  sonarsource/sonar-scanner-cli `
  -Dsonar.projectKey=testando-sonarqube `
  -Dsonar.projectName=aider `
  -Dsonar.sources=. `
  -Dsonar.python.version=3.12 `
  -Dsonar.exclusions=**/tests/**,**/scripts/**,**/website/**,**/__pycache__/**,**/.git/**,**/.venv/**,**/node_modules/**
