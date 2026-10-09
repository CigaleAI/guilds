export const CASES: Array<{
  id: string;
  expect_post: boolean;
  viewer: string;
  viewer_id: string;
  members: string[];
  history: Array<{ sentBy: string; content: string }>;
}> = [
  {
    id: "reply_who_is_here",
    expect_post: true,
    viewer: "first-agent",
    viewer_id: "a_first",
    members: ["first-agent", "second-agent"],
    history: [{ sentBy: "user", content: "hello, who is here?" }],
  },
  {
    id: "reply_open_question",
    expect_post: true,
    viewer: "first-agent",
    viewer_id: "a_first",
    members: ["first-agent", "second-agent"],
    history: [{ sentBy: "user", content: "What is the capital of France?" }],
  },
  {
    id: "reply_explicitly_asked",
    expect_post: true,
    viewer: "second-agent",
    viewer_id: "a_second",
    members: ["first-agent", "second-agent"],
    history: [
      {
        sentBy: "user",
        content: "second-agent, please post the next research update.",
      },
    ],
  },
  {
    id: "reply_peer_asks",
    expect_post: true,
    viewer: "second-agent",
    viewer_id: "a_second",
    members: ["first-agent", "second-agent"],
    history: [
      { sentBy: "user", content: "Please coordinate." },
      {
        sentBy: "first-agent",
        content: "second-agent, please reply with what you found.",
      },
    ],
  },
  {
    id: "silence_peer_already_answered",
    expect_post: false,
    viewer: "second-agent",
    viewer_id: "a_second",
    members: ["first-agent", "second-agent"],
    history: [
      { sentBy: "user", content: "What is the capital of France?" },
      { sentBy: "first-agent", content: "Paris." },
    ],
  },
  {
    id: "silence_user_thanks",
    expect_post: false,
    viewer: "first-agent",
    viewer_id: "a_first",
    members: ["first-agent", "second-agent"],
    history: [
      { sentBy: "user", content: "What is the capital of France?" },
      { sentBy: "first-agent", content: "Paris." },
      { sentBy: "user", content: "thanks" },
    ],
  },
  {
    id: "silence_peer_status_note",
    expect_post: false,
    viewer: "second-agent",
    viewer_id: "a_second",
    members: ["first-agent", "second-agent"],
    history: [
      { sentBy: "user", content: "hello, who is here?" },
      {
        sentBy: "first-agent",
        content:
          "I reviewed the note indexes and recorded status in " +
          "guilds/guild/shared/research-update.md. Please send a " +
          "concrete research question when ready.",
      },
    ],
  },
];
