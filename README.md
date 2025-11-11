# OurTextScores

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

OurTextScores is an open, community-driven platform for publishing and transcribing machine-readable music scores (MusicXML, MuseScore). The platform supports version control, semantic diffs, derivative generation, and collaborative workflows for music transcription projects.

## Project Goals

- Provide a complementary platform to IMSLP focused on machine-readable music scores
- Support transcription communities and projects 
- Enable fine-grained version history using Fossil VCS for each score source
- Offer branching, approval workflows, and collaborative transcription features
- Generate derivatives automatically (PDF, linearized XML, canonical XML)
- Provide semantic music diffs (musicdiff) for visualizing notation changes

## Quick Start

```bash
docker compose up -d
```

The command builds the frontend and backend images locally and starts the supporting services (MongoDB, MeiliSearch, MinIO, Mailpit). Visit `http://localhost:3000` for the web UI and `http://localhost:4000/api` for the API.

## Service Overview

| Service   | Port | Description                                    |
|-----------|------|------------------------------------------------|
| frontend  | 3000 | Next.js 14 App Router interface                |
| backend   | 4000 | NestJS API with derivative pipeline            |
| mongo     | 27017 (mapped to 27018) | MongoDB for metadata and accounts |
| meili     | 7700 | MeiliSearch (planned for full-text search)     |
| minio     | 9000/9001 (mapped to 9002/9003) | S3-compatible object storage |
| mailpit   | 8025/1025 | Email testing (SMTP + web UI)                 |
| fossil    | volume | Per-source Fossil VCS repositories            |

## Key Features

- **Version Control**: Per-source Fossil repositories with branching and merge workflows
- **Derivative Generation**: Automatic conversion (MuseScore → MXL → canonical XML → linearized text → PDF)
- **Semantic Diffs**: Visual musicdiff PDFs and text diffs showing notation changes
- **IMSLP Integration**: Fetch metadata and link to IMSLP works
- **Approval Workflows**: Branch policies (public/owner-approval) for quality control
- **Notifications**: Email notifications for watched sources (immediate or digest)
- **Authentication**: NextAuth with Email + optional OAuth (Google/GitHub)

## Documentation

- **[AGENTS.md](AGENTS.md)**: Comprehensive guide for developers and AI agents working on the codebase

## License

**Platform Code**: This project is licensed under the [GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0) (AGPL-3.0). See the `LICENSE` file for full terms.

**User-Contributed Content**: Uploaded musical scores may be licensed separately by contributors. The platform supports attaching Creative Commons and other licenses to individual works.

The AGPL ensures that if you run a modified version of OurTextScores as a web service, you must make your source code available to users of that service. This keeps the platform and all improvements open and community-driven.

## Contributing

Contributions are welcome! Please ensure:
- New features include unit tests (backend) and smoke tests (E2E) where applicable
- Code follows existing patterns (see AGENTS.md)
- Commit messages are descriptive

When you contribute code, you agree to license it under AGPL-3.0.
