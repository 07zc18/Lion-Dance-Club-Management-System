# Lion Dance Club Management System v2

Account-based Lion Dance Club Management System using React + Vite, Express, SQLite, bcrypt password hashing and JWT authentication.

## Features
- Email/password registration and login; each account has isolated records in SQLite.
- Pending and past orders; clickable event names open full event details.
- Add performers directly in an order or in the performer directory. Performer directory stores names only; role and salary are stored per order.
- Default salary rates by role in Settings; changing a rate does not change historical order salary records.
- Pending and paid salary views.
- Finance calculator with commission percentage calculator, transportation/food/other expense records, and net earnings calculation.
- Utilities inventory and purchase history.
- Dashboard excludes performer salary figures.

## Run in GitHub Codespaces
```bash
npm install
npm run dev
```
Open forwarded port **5173** for the frontend. The backend API runs on port **5000** and is proxied automatically by Vite (see `vite.config.js`).

## Production
```bash
npm run build
npm start
```
Set `JWT_SECRET` to a long random secret before deploying. SQLite data is stored in `server/club-data.sqlite`; deploy with a persistent disk/volume or use a managed database for production hosting. Do not delete this file if you need to keep your records.

## Important
This starter uses SQLite on the server. In GitHub Codespaces, it persists in the workspace while the workspace and its files are retained. For multi-user public hosting, use persistent server storage, HTTPS, backups, and a production-grade database such as PostgreSQL.
