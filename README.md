# Cloud Run Demo

This is a demo app. It asks short questions about Cloud Run, sends your answer to Gemini, and then shows another question.

## How it works

The backend is an Express server. It serves the page in `frontend` and grades each answer.

1. The page shows a question.
2. You type an answer and click **Submit**.
3. The server sends the question and your answer to Gemini.
4. A right answer is replaced by the next question right away.
5. A wrong answer shows the correct answer for 5 seconds. That text is then removed and the next question appears.

The next question comes from a fixed list in the server. Gemini decides if your answer is right. When it is wrong, Gemini writes the correct answer.

## Run it

Use Node.js 22 or newer. From the `backend` folder:

```bash
npm install
npm start
```

Open [http://localhost:8080](http://localhost:8080).

Create `backend/.env` with:

| Name | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Your Gemini API key |
| `GEMINI_MODEL` | Model name. Defaults to `gemini-3.8-flash` |

