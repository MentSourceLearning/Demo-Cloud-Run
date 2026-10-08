const questionEl = document.getElementById("question");
const answerEl = document.getElementById("answer");
const resultEl = document.getElementById("result");
const button = document.getElementById("submit");
const readAnswerMs = 5000;

function setBusy(busy) {
  button.disabled = busy;
  answerEl.disabled = busy;
}

function showNextQuestion(question) {
  questionEl.textContent = question;
  answerEl.value = "";
  resultEl.className = "";
  resultEl.textContent = "";
  setBusy(false);
  answerEl.focus();
}

button.addEventListener("click", async () => {
  const question = questionEl.textContent.trim();
  const answer = answerEl.value.trim();
  resultEl.className = "";

  if (!question || !answer) {
    resultEl.textContent = question
      ? "Type an answer, then submit."
      : "Type a question first.";
    return;
  }

  setBusy(true);
  resultEl.textContent = "Checking...";

  try {
    const response = await fetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, answer }),
    });
    const body = await response.json();

    if (!response.ok) {
      resultEl.textContent = body.error || "Could not check the answer.";
      setBusy(false);
      return;
    }

    const nextQuestion = String(body.nextQuestion ?? "").trim();
    if (!nextQuestion) {
      resultEl.textContent = "Could not load the next question.";
      setBusy(false);
      return;
    }

    if (body.correct) {
      showNextQuestion(nextQuestion);
      return;
    }

    resultEl.className = "wrong";
    resultEl.textContent = body.rightAnswer
      ? `Not quite. Right answer: ${body.rightAnswer} Next: ${nextQuestion}`
      : `That answer is not right. Next: ${nextQuestion}`;
    await new Promise((resolve) => setTimeout(resolve, readAnswerMs));
    showNextQuestion(nextQuestion);
  } catch (_error) {
    resultEl.className = "";
    resultEl.textContent = "Could not reach the backend.";
    setBusy(false);
  }
});
