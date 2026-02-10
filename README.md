<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-clarity-fm

Find and book expert calls on Clarity.fm via CLI-based browser automation (zero context overhead)

![Version](https://img.shields.io/badge/version-1.2.3-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- **search-experts** — Search by keyword with rate/sort filters
- **view-profile** — Extract detailed expert profile data
- **compare-experts** — Side-by-side comparison of 2-3 experts
- **fill-booking** — Fill booking form (does NOT submit)
- **submit-booking** — Submit after user confirmation
- **list-calls** — View calls from dashboard
- **budget-status** — Show monthly spend and remaining budget
- **set-budget** — Set monthly spending cap (USD)
- **screenshot** — Take screenshot of current page
- **reset** — Close browser and clear session

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- API credentials for the target service (see Configuration)

## Quick Start

```bash
git clone https://github.com/YOUR_GITHUB_USER/claude-code-plugin-clarity-fm.git
cd claude-code-plugin-clarity-fm
cp config.template.json config.json  # fill in your credentials
cd scripts && npm install
```

```bash
node scripts/dist/cli.js search-experts
```

## Installation

1. Clone this repository
2. Copy `config.template.json` to `config.json` and fill in your credentials
3. Install dependencies:
   ```bash
   cd scripts && npm install
   ```

## Available Commands

### Available CLI Commands

| Command           | Purpose                                  | Type            |
| ----------------- | ---------------------------------------- | --------------- |
| `search-experts`  | Search by keyword with rate/sort filters | Read            |
| `view-profile`    | Extract detailed expert profile data     | Read            |
| `compare-experts` | Side-by-side comparison of 2-3 experts   | Read            |
| `fill-booking`    | Fill booking form (does NOT submit)      | Write (safe)    |
| `submit-booking`  | Submit after user confirmation           | Write (payment) |
| `list-calls`      | View calls from dashboard                | Read            |
| `budget-status`   | Show monthly spend and remaining budget  | Local           |
| `set-budget`      | Set monthly spending cap (USD)           | Local           |
| `screenshot`      | Take screenshot of current page          | Utility         |
| `reset`           | Close browser and clear session          | Utility         |

### search-experts Options

| Option         | Description                                               | Default    |
| -------------- | --------------------------------------------------------- | ---------- |
| `--query TEXT` | Search keyword (required)                                 | -          |
| `--min-rate N` | Minimum USD/min                                           | -          |
| `--max-rate N` | Maximum USD/min                                           | -          |
| `--sort VALUE` | `best_match`, `rate`, or `calls`                          | best_match |
| `--page N`     | Results page                                              | 1          |
| `--limit N`    | Max results (max: 20)                                     | 10         |
| `--enrich N`   | Enrich top N results with real ratings from profile pages | -          |

### view-profile Options

| Option          | Description                     |
| --------------- | ------------------------------- |
| `--expert TEXT` | Username or full URL (required) |

### compare-experts Options

| Option           | Description                               |
| ---------------- | ----------------------------------------- |
| `--experts TEXT` | Comma-separated usernames, 2-3 (required) |

### fill-booking Options

| Option          | Description                | Default        |
| --------------- | -------------------------- | -------------- |
| `--expert TEXT` | Username or URL (required) | -              |
| `--duration N`  | Minutes (15-120)           | 30             |
| `--topic TEXT`  | Call topic/description     | -              |
| `--slot1 TEXT`  | Proposed time 1 (ISO 8601) | -              |
| `--slot2 TEXT`  | Proposed time 2 (ISO 8601) | -              |
| `--slot3 TEXT`  | Proposed time 3 (ISO 8601) | -              |
| `--phone TEXT`  | Phone number override      | Config default |

### list-calls Options

| Option           | Description                               | Default |
| ---------------- | ----------------------------------------- | ------- |
| `--status VALUE` | `upcoming`, `pending`, `completed`, `all` | all     |

### budget-status Options

| Option            | Description    | Default |
| ----------------- | -------------- | ------- |
| `--month YYYY-MM` | Month to check | Current |

### set-budget Options

| Option        | Description           |
| ------------- | --------------------- |
| `--monthly N` | Cap in USD (required) |

## Usage Examples

```bash
node scripts/dist/cli.js compare-experts --experts "alice,bob,carol"
```

```bash
node scripts/dist/cli.js budget-status
```

```bash
node scripts/dist/cli.js set-budget --monthly 200
```

## How It Works

This plugin connects directly to the service's HTTP API. The CLI handles authentication, request formatting, pagination, and error handling, returning structured JSON responses.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Authentication errors | Verify credentials in `config.json` |
| `ERR_MODULE_NOT_FOUND` | Run `cd scripts && npm install` |
| Rate limiting | The CLI handles retries automatically; wait and retry if persistent |
| Unexpected JSON output | Check API credentials haven't expired |

## Contributing

Issues and pull requests are welcome.

## License

MIT
