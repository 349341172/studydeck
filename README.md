# StudyDeck Nexus — Full-stack personal study ecosystem

This package turns the standalone StudyDeck prototype into a real account-backed study service.

## What is implemented

- Hierarchical folders and independent units.
- Flashcards, difficult MCQs, and long-form questions.
- Long-form answers are graded semantically against an **essential rubric**, not by word matching.
- Optional AI grading runs server-side so the API key is never exposed to the browser.
- Practice-paper templates have their own spaced schedule.
- When a paper becomes due, the app generates a **fresh version** and avoids prior prompts.
- Google sign-in.
- Server-side account persistence with optimistic revision sync.
- Google Drive JSON backup/restore.
- Telegram reminder bot.
- Each unit is reminded separately.
- Browser-local IndexedDB remains as an offline fallback.
- Portable JSON exports remain available.

## Why Telegram rather than WhatsApp for v1

Telegram's Bot API is straightforward for a personal reminder bot: one bot token, a linked chat ID, and `sendMessage`.
WhatsApp Cloud API is viable but adds Meta app/business configuration and template-message requirements. Telegram is the lower-friction personal option.

## AI model

`OPENAI_MODEL` is configurable in `.env`.

The supplied default is:

    OPENAI_MODEL=gpt-5.6-luna

It is intended for fast, inexpensive semantic checks. If your OpenAI API account exposes another model you prefer, change the environment variable without modifying the frontend.

The AI grader receives only:
- the selected question,
- its essential rubric,
- the relevant unit notes,
- your submitted answer.

It is instructed to mark **the idea in spirit**, not exact wording. You can always reveal the rubric and override the model by rating yourself.

## Setup

1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Run:

    npm install
    npm start

4. Open `http://localhost:3000`.

### Google OAuth

Create a Google Cloud project and OAuth web client.

Use:
- Authorized JavaScript origin: `http://localhost:3000`
- Redirect URI: `http://localhost:3000/auth/google/callback`

Enable the Google Drive API.

Put the client ID/secret in `.env`.

The app requests `drive.file`, so it can create and update files that StudyDeck itself creates.

### OpenAI

Set `OPENAI_API_KEY` in `.env`.

Do **not** put an OpenAI API key in `index.html`, browser localStorage, or client-side JavaScript.

### Telegram

1. Create a bot with BotFather.
2. Set `TELEGRAM_BOT_TOKEN`.
3. Set the bot username without `@` as `TELEGRAM_BOT_USERNAME`.
4. Restart the server.
5. In StudyDeck: Settings & sync → Connect Telegram bot → Start.

The server polls Telegram for the one-time linking command and stores only the resulting chat ID.

## Scheduling model

Cards and long-form prompts use the existing `Again / Hard / Good / Easy` review scheduling.

Practice papers use longer intervals. The paper template is scheduled; the **paper questions are not reused**. On the next due date the app creates a new paper version using:
- unit source notes,
- the paper topic specification,
- approved long-form rubrics,
- prior generated prompts as a negative set to avoid repetition.

This solves the "I already know the old paper's answers" problem.

## Recommended hierarchy

- School
  - Biology
    - Unit 1
    - Unit 2
  - Computer Science
    - Unit 1
- Islamic Studies
  - Kalām
    - Divine Attributes
  - Uṣūl
    - Dalālah
- Philosophy
  - Epistemology
  - Metaphysics
  - Logic

Each **unit** owns its own items, due dates, paper templates, source notes, and review history.

## Production deployment

This starter is designed for one person or a very small number of users. Its database is a single JSON file with atomic writes.

For a serious public deployment, replace the JSON store with PostgreSQL/SQLite, use a managed session store, and deploy behind HTTPS.

Suitable simple hosts include a small VPS or a platform that runs a persistent Node process. If you deploy to a serverless platform, move persistence and the reminder scheduler to managed services/cron jobs.

## Privacy

Long-form answers are **not** sent to OpenAI by default. The UI requires explicit AI consent and a deliberate AI-check action.

Google Drive backups are separate from the server database. Export a local JSON backup occasionally as an additional recovery layer.
