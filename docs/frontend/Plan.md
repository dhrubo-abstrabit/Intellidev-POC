# Project Brain

## Overview

Build a modern SaaS web application that acts as a **Project Intelligence Platform**.

The application allows organizations to create workspaces, manage projects, connect external collaboration tools, continuously synchronize data, and use an LLM to generate daily project action items.

The application should be built using:

- **Frontend:** Next.js (App Router) + TypeScript
- **Backend:** Next.js Route Handlers / Server Actions
- **Database & Auth:** Supabase
- **Styling:** Tailwind CSS + shadcn/ui
- **Queue:** Upstash QStash or BullMQ
- **LLM:** OpenAI API (pluggable)
- **Deployment:** Vercel

---

# Core Features

## Authentication

Use Supabase Authentication.

Support:

- Email/Password
- Google OAuth

After login:

- Create a workspace
- Join existing workspace (future)
- Switch between workspaces

---

# Workspace Management

Each user can own multiple workspaces.

Workspace contains:

- Name
- Description
- Logo
- Created At
- Members (future)
- Projects

Example:

Workspace
```

Acme Technologies

```

Projects

- Internal Dashboard
- Mobile App
- Customer Portal

```

---

# Project Management

Inside every workspace users can create multiple projects.

Project contains:

- Name
- Description
- Status
- Created At
- Connected Integrations
- Daily Action Items
- Activity Feed

---

# Integrations

Users should be able to connect external data sources.

Supported initially:

- Slack
- Google Chat
- Google Drive
- ClickUp


Future:

- GitHub
- Jira
- Linear
- Gmail
- Notion
- Confluence
- Zoom
- Google Meet

Each integration should have:

- Connect button
- OAuth flow (where applicable)
- Status
- Last Sync
- Disconnect

---

# Synchronization Engine

Each integration should synchronize automatically.

Requirements:

- Periodic synchronization
- Incremental sync
- Store sync cursor
- Retry failed syncs
- Log every sync

Possible schedule:

- Every 15 minutes
- Manual "Sync Now"

Sync Pipeline:

Connector

↓

Fetch New Data

↓

Normalize Events

↓

Store Raw Payload

↓

Transform

↓

Store Normalized Events

↓

Queue LLM Processing

---

# Event Storage

Every incoming event should be stored.

Two tables:

## Raw Events

Contains:

- Connector
- Payload
- Timestamp
- Workspace
- Project

## Normalized Events

Contains standardized fields regardless of source.

Example:

```

{
"id": "...",
"type": "task.created",
"actor": "...",
"resource": "...",
"timestamp": "...",
"metadata": {}

}

```

---

# LLM Processing

Once new normalized events arrive they should be queued for AI processing.

The LLM receives:

- New events
- Previous project context
- Existing action items
- Historical summaries

The LLM generates:

- Action Items
- Risks
- Blockers
- Important Updates
- Follow-ups

---

# Daily Action Items

Each day the application generates actionable tasks.

Example:

## Today

- Follow up with backend team regarding API changes.
- Review ClickUp tasks assigned yesterday.
- Investigate Slack discussion regarding deployment failure.
- Update project documentation.

Each action item contains:

- Title
- Description
- Priority
- Confidence Score
- Source Events
- Generated At

---

# Dashboard

Project Dashboard should display:

## Overview

- Project Health
- Active Integrations
- Last Sync
- Pending Action Items

## Today's Action Items

Card list.

## Recent Activity

Timeline of normalized events.

## Connected Services

Status of every connector.

---

# Connector Architecture

Create a connector interface.

Example:

```

interface Connector {
connect()
disconnect()
sync()
normalize()
validate()
}

```

Every connector should implement this interface.

---

# Database Design

Core tables:

Users

Workspaces

Workspace Members

Projects

Integrations

Connector Credentials

Sync Jobs

Raw Events

Normalized Events

Action Items

LLM Runs

Daily Summaries

Audit Logs

---

# Supabase

Use:

- Authentication
- Postgres
- Storage
- Realtime (optional)
- Row Level Security

Every table must include proper RLS policies.

---

# Background Jobs

Background workers should handle:

- Connector synchronization
- Event normalization
- LLM processing
- Daily summary generation
- Cleanup jobs

No heavy AI processing should happen inside API routes.

---

# User Experience

Navigation

Workspace

└── Projects

├── Dashboard

├── Action Items

├── Activity

├── Integrations

├── Settings

---

# Integrations Page

Display all supported integrations.

Example cards:

Slack

Status:
Connected

Last Sync:
5 minutes ago

[Reconnect]

[Sync Now]

[Disconnect]

---

# AI Features

The AI should:

- Read normalized events
- Understand project history
- Detect blockers
- Detect deadlines
- Detect task ownership
- Generate concise action items
- Avoid duplicates
- Merge similar recommendations

---

# Security

- Encrypt OAuth tokens
- Never expose secrets to frontend
- Validate webhooks
- Secure API routes
- Enforce workspace isolation
- Apply Supabase RLS

---

# Future Enhancements

- Knowledge Graph
- Semantic Search
- AI Chat over project history
- Cross-project insights
- Team member recommendations
- Meeting summaries
- Sprint health
- Risk prediction
- Automated project status reports

---

# Non-Functional Requirements

- Fully typed TypeScript
- Modular architecture
- Repository pattern
- Dependency Injection where appropriate
- Clean folder structure
- Scalable connector framework
- Easy to add new integrations
- Responsive UI
- Comprehensive error handling
- Logging and monitoring
- Unit and integration tests

---

# Suggested Folder Structure

```

app/
(auth)
dashboard/
workspace/
project/

components/
ui/
dashboard/
integrations/

lib/
auth/
db/
llm/
queue/
supabase/
connectors/

connectors/
slack/
google-chat/
google-drive/
clickup/
github/

services/
sync/
events/
action-items/
integrations/

jobs/
sync/
llm/
cleanup/

types/

hooks/

utils/

```

---

# Success Criteria

The application should allow a user to:

1. Sign up using Supabase Authentication.
2. Create one or more workspaces.
3. Create multiple projects within each workspace.
4. Connect external services such as Slack, Google Chat, Google Drive, ClickUp.
5. Automatically synchronize data from connected services on a scheduled basis.
6. Store both raw and normalized events for auditing and processing.
7. Process newly synchronized events through an LLM pipeline.
8. Generate accurate daily action items, blockers, and follow-up recommendations for each project.
9. View project health, recent activity, integration status, and AI-generated insights from a centralized dashboard.
10. Provide a modular foundation that supports adding new integrations and AI capabilities with minimal changes.