# MWG CRM

Internal CRM platform for **Morgan White Group** — built to manage leads, contacts, and customer relationships with enterprise SSO and email tracking.

## Status

Early scaffold. The app currently renders a blank shell while infrastructure, authentication, and the data model are wired up.

## Planned Capabilities

- **Lead and contact management** backed by a relational database
- **SAML SSO** sign-in via **Microsoft Azure Entra ID**
- **Light and dark themes** with system-preference detection
- **Outlook integration** to automatically track outbound and inbound emails against lead records
- Activity timeline, notes, and assignments per lead
- Role-based access control for sales, support, and admin users

## Tech Stack

- **Next.js 16** (React 19) with App Router
- **Tailwind CSS v4**
- **TypeScript**
- **Vercel** for hosting (auto-deployed on push via Git integration)
- Azure Entra ID for SAML SSO _(planned)_
- Microsoft Graph API for Outlook integration _(planned)_

## Getting Started

### Prerequisites
- Node.js 20+
- npm

### Installation
```bash
git clone https://github.com/DustinHannon/MWG_CRM.git
cd MWG_CRM
npm install
```

### Development
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### Build
```bash
npm run build
```

## Project Structure

```
src/
└── app/
    ├── globals.css    # Global styles, light/dark theme tokens
    ├── layout.tsx     # Root layout, fonts, SEO metadata
    └── page.tsx       # Home page
public/                # Static assets
```

## Deployment

The site auto-deploys to Vercel on every push to `master` via Git integration. Preview deployments are created for pull requests automatically.
