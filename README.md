# Scrutiny 🔍

AI-powered GitHub profile analyzer. Enter any username and get a full technical report — code quality, inferred seniority, language patterns, and job-fit score.

## How it works

**Dual-model pipeline:**

1. LLaMA 3.1 8B (fast) → reads repo list and selects the 5 most relevant
2. LLaMA 3.3 70B (deep) → reads actual code files and generates the analysis
3. LLaMA 3.1 8B (judge) → scores the developer based on the analysis

## Tech Stack

**Frontend:** HTML · CSS · JavaScript  
**Backend:** Node.js · Express  
**APIs:** GitHub API (Octokit) · Groq (LLaMA)

## Getting Started

```bash
cd backend
cp .env.example .env
# Fill in GITHUB_TOKEN and GROQ_API_KEY in .env

npm install
npm start
```

Open: http://localhost:8000

## Project Structure

```
scrutiny/
├── frontend/
│   ├── index.html
│   ├── sobre.html
│   ├── style.css
│   └── script.js
└── backend/
    ├── server.js         # Express server + routes
    ├── github-service.js # GitHub API client (Octokit)
    ├── groq-service.js   # Groq AI pipeline (dual-model)
    ├── .env.example      # Environment variables template
    └── package.json
```

## Features

- Analyzes real repository code (not just metadata)
- 3 analysis modes: Self-analysis, Recruitment, Job-fit
- Score with breakdown: quality, activity, documentation
- Supports GitHub username or profile URL
