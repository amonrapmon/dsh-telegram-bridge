# Contributing

Thank you for helping make topic-aware Telegram access to Harness reliable.

## Development

Use Node.js 22.19+.

```sh
npm run check
npm test
```

The unit tests use fake Harness services and Telegram API responses.
No real token or paid model API key is needed.

## Pull requests

- Preserve the chat+topic-to-session isolation invariant.
- Prefer public DSH APIs over private internal imports.
- Add a test for new routing and lifecycle behavior.
- Keep service messages in English by default.
- Never translate or rewrite the assistant's generated response.
- Do not include credentials, raw chats, or personal data in fixtures.
- Document incomplete features as incomplete.

Please open an issue before major architectural rewrites.
