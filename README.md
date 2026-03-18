# linear-standup

Local web tool for standups. Fetches the last 24h of Linear activity for every team member, lets you add notes per person, and copies the result as Markdown.

## Setup

```bash
npm install
cp .env.example .env
# Add your Linear API key to .env
npm start
```

Open http://localhost:3123

## Usage

1. Select your team from the dropdown
2. Click **Fetch activity** — shows updated issues, created issues, and comments per member
3. Add notes in the text field under each person
4. Click **Copy as Markdown** — the full standup is copied to your clipboard, ready to paste into Notion or wherever
