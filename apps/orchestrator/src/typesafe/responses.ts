import { Type } from "@sinclair/typebox";

// The System One replies the client reads. Each object keeps the fields TypeSafe sends beyond the
// ones named; a field the client reads only when it has the expected shape is `Kept`.

const Kept = Type.Optional(Type.Unknown());

/** A JSON object whose fields are read one by one. */
export const Fields = Type.Record(Type.String(), Type.Unknown());

export const Usage = Type.Object({
  input_tokens: Type.Optional(Type.Number()),
  output_tokens: Type.Optional(Type.Number()),
});

/** An evaluation reply: the answers by question id, each decoded by its question's type. */
export const SystemOneResponse = Type.Object({ model: Kept, answers: Fields, usage: Kept });

export const NoulAnswerBody = Type.Object({
  type: Type.Literal("noul"),
  noul: Type.Number({ minimum: 0, maximum: 1 }),
});

export const ChoiceAnswerBody = Type.Object({
  type: Type.Literal("choice"),
  choice: Type.String({ minLength: 1 }),
  probabilities: Kept,
  confidence: Kept,
});

export const ScoreAnswerBody = Type.Object({
  type: Type.Literal("score"),
  score: Type.Number(),
  legend: Kept,
  probabilities: Kept,
  confidence: Kept,
});

/** An error body: the message sits in `message` or `error`, as text. */
export const ErrorBody = Type.Object({ message: Kept, error: Kept });
