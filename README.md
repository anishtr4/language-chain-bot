# Bubble FAQ Bot

FAQ chatbot with knowledge-base first retrieval and OpenAI enhancement for natural, accurate answers.

## Features
- Knowledge base (JSON/CSV import)
- TF-IDF retrieval + cosine similarity
- Optional OpenAI for human-like phrasing and fallback
- Chat UI with sources and confidence
- Admin UI to manage FAQs
- Logs unanswered questions to `data/unanswered.log`

## Setup
```bash
cp .env.example .env
# put your OpenAI key
npm install
npm run dev
```
Open http://localhost:3000

## Admin
- Manage at `/admin.html`
- Import JSON (array) or CSV (columns: question,answer[,title,tags])
- Tags separated by `|`

## API
- `POST /api/chat` { message }
- `GET /api/faq`
- `POST /api/faq` { items: [...] }
- `POST /api/faq/import?append=true|false` multipart `file`

## Deploy
- Any Node host (Render, Railway, Heroku, Vercel Functions via serverless-adapter)
- Set `OPENAI_API_KEY`
