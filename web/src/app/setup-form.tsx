export interface SetupQuestion {
  name: string;
  type: string;
  label: string;
  required: boolean;
  choices?: string[];
  prompt: string;
  cleared?: string;
}

export function SetupForm({
  action,
  questions,
  submit,
}: {
  action: string;
  questions: SetupQuestion[];
  submit: string;
}) {
  return (
    <form action={action} method="post">
      {questions.map((question) => (
        <label key={question.name}>
          {question.prompt}
          {question.cleared ? <span className="muted"> Cleared {question.cleared}.</span> : null}
          {question.type === "secret" || question.type === "file" ? (
            <input disabled placeholder="Entered on your device, never sent" />
          ) : question.type === "choice" ? (
            <select name={`a_${question.name}`}>
              {(question.choices ?? []).map((choice) => (
                <option key={choice}>{choice}</option>
              ))}
            </select>
          ) : (
            <input name={`a_${question.name}`} required={question.required} />
          )}
        </label>
      ))}
      <button className="primary" type="submit">{submit}</button>
    </form>
  );
}
