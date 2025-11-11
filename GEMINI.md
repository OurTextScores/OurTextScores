This is a full-stack web application for collaboratively editing music scores.

**Project Overview:**

*   **Purpose:** An open, community-driven platform for publishing and transcribing machine-readable music scores (MusicXML, MuseScore). It supports version control, semantic diffs, derivative generation, and collaborative workflows.
*   **Frontend:** A Next.js 14 application using the App Router, Tailwind CSS for styling, and OpenSheetMusicDisplay (OSMD) for rendering scores.
*   **Backend:** A NestJS API that manages data, authentication, and a derivative pipeline for processing scores. It uses MongoDB for data storage, MinIO for object storage, and Fossil for version control.
*   **Orchestration:** The entire application is orchestrated with Docker Compose, which manages the frontend, backend, and supporting services.

**Building and Running:**

*   **Primary Method (Docker):** The recommended way to run the application is with Docker Compose.
    *   To start all services: `docker compose up -d`
    - To rebuild the containers: `docker compose up -d --build`
*   **Local Development:**
    *   **Frontend:**
        ```bash
        cd frontend
        npm install
        npm run dev
        ```
    *   **Backend:**
        ```bash
        cd backend
        npm install
        npm run start:dev
        ```
*   **Testing:**
    *   **Unit Tests:**
        *   Run all unit tests: `npm run test:unit`
        *   Backend only: `npm run test:unit:backend`
        *   Frontend only: `npm run test:unit:frontend`
    *   **Smoke Tests (E2E):** The project uses Playwright for end-to-end testing.
        *   Run all smoke tests: `npm run smoke`
        *   Run smoke tests without teardown: `npm run smoke:run`

**Development Conventions:**

*   **Code Style:** The project uses Prettier for code formatting and ESLint for linting.
*   **API:** The backend exposes a REST API, with comprehensive documentation available via Swagger UI at `http://localhost:4000/api-docs`.
*   **Authentication:** Authentication is handled by NextAuth, with support for email and OAuth providers.
*   **Version Control:** The project uses Git for its own source code, and each music score has its own Fossil version control repository.
*   **Contribution Guidelines:**
    *   New features should include unit tests and smoke tests.
    *   Code should follow existing patterns.
    *   Commit messages should be descriptive.
*   **Key Document:** For a much more detailed guide on the architecture, conventions, and development workflows, please refer to `AGENTS.md`.
