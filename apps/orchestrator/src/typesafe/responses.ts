import { Type } from "@sinclair/typebox";

// The System One replies the client reads. An object may carry fields beyond the ones named, which
// the client does not read; an optional field that does not have its shape is read as absent.

/** A probability or a confidence: a number from 0 to 1. */
const UnitInterval = Type.Number({ minimum: 0, maximum: 1 });

/** How likely each option was, by option. */
const Probabilities = Type.Record(Type.String(), Type.Number());

/** The tokens an evaluation spent. */
export const Usage = Type.Object({
  input_tokens: Type.Optional(Type.Number()),
  output_tokens: Type.Optional(Type.Number()),
});

/**
 * An evaluation reply beside its answers: the model that answered and the tokens it spent. Its
 * `answers` object holds one answer per question id, each read by the type of its question.
 */
export const SystemOneReply = Type.Object({
  model: Type.Optional(Type.String()),
  usage: Type.Optional(Usage),
});

/** The answer to a Noul question: how true the statement is, from 0 to 1. */
export const NoulAnswer = Type.Object({
  type: Type.Literal("noul"),
  noul: UnitInterval,
});

/** The answer to a Choice question: the option picked, how likely each was, and how sure it is. */
export const ChoiceAnswer = Type.Object({
  type: Type.Literal("choice"),
  choice: Type.String({ minLength: 1 }),
  probabilities: Probabilities,
  confidence: UnitInterval,
});

/** The answer to a Score question: the score, what each level means, how likely each was. */
export const ScoreAnswer = Type.Object({
  type: Type.Literal("score"),
  score: Type.Number(),
  legend: Type.Record(Type.String(), Type.String()),
  probabilities: Probabilities,
  confidence: UnitInterval,
});

/** An error body: the message sits in `message` or `error`, as text. */
export const ErrorBody = Type.Object({
  message: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});
