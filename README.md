# Bench Ledger

A shared expense tracker for group projects. Log what you buy (with receipt photos), see how much was spent, and see who owes whom. When a project is finished, archive it and start a new one in the same app.

- **Frontend:** plain HTML/CSS/JS, no build step, hosted free on GitHub Pages.
- **Data, login and receipt photos:** Supabase (free tier).
- **Split:** every expense is split equally between all members of the project.

## What you can do

| Tab | What it does |
|---|---|
| Overview | Total spent, budget left, who paid what, spending by category and over time |
| Expenses | Search and filter everything bought, as a list or as cards; add, edit, delete and restore; attach receipt photos |
| Owners | Who holds each component. The project creator assigns items, members request items, the creator approves or declines |
| Settle up | Shows who is above or below an equal split, the fewest payments to square up, and a record of payments made |
| Project | Import past expenses (CSV or Excel, with a preview), Excel/CSV export, budget, categories, members, archive the project |

Rules worth knowing:
- You can edit an expense only if you **added it or paid for it**. Anyone can view everything.
- Deleting is a soft delete ("Show deleted" lets you restore). Every edit is recorded in the expense's history.
- Items with status **Needed** are planned purchases: they show up in the list but are not counted in spending or splits until you change them to Ordered, Received or Used.
- Only the project creator manages members, budget, categories and archiving.
- **Temporary members:** add a member by name only (no email). You can record expenses for them and assign items to them straight away. When you have their email, open Project > Members and tap **Assign email**; the first time they sign in with it they are linked to that name and everything under it. An email can be assigned once.
- **Component owners:** "owner" means who holds or keeps the item, which can differ from who paid. The creator assigns items on the Owners tab. Any member can request an item they do not hold (with a note); the creator sees a badge on the Owners tab and approves or declines. Approving assigns the item and closes other open requests for it.

---

## Setup (about 15 minutes, one time)

### 1. Create the Supabase project
1. Sign up at <https://supabase.com> and click **New project**. Pick any name and region (Southeast Asia / Singapore is closest), set a database password, and wait for it to finish.
2. Open **SQL Editor > New query**, paste the whole contents of `supabase/schema.sql`, and click **Run**. You should see "Success". (It is safe to run again later.)
3. Open **Project Settings > API** and copy two values: the **Project URL** and the **anon public** key.
   Never use the `service_role` key anywhere in this app.

### 2. Put the keys in the app
Open `js/config.js` and replace the two placeholder values with your Project URL and anon key. The anon key is meant to be public, so it is fine in a public repository: your data is protected by the security rules in `schema.sql`, not by hiding the key.

### 3. Push to GitHub and turn on Pages
1. Create a new **public** repository on GitHub and push this folder to the `main` branch.
2. In the repo, go to **Settings > Pages**, and under **Build and deployment** set **Source** to **GitHub Actions**.
3. The workflow in `.github/workflows/deploy.yml` runs on every push to `main`: it runs the tests, then publishes the site. Watch it under the **Actions** tab. When it finishes, your site is at `https://<your-username>.github.io/<repo-name>/`.

### 4. Tell Supabase your site address
In Supabase go to **Authentication > URL Configuration** and set:
- **Site URL:** your GitHub Pages address (for example `https://yourname.github.io/bench-ledger/`)
- **Redirect URLs:** add the same address

Without this, sign-in links will point to the wrong place.

### 5. Sign in and create your project
1. Open your site. Sign in with your email (see "Signing in" below).
2. Click **New project**, enter the name and add all three members with the emails they will sign in with. Your own email is already filled in.
3. Send each teammate the site link. When they sign in with the email you entered, they see the project automatically.

### 6. Import your past expenses
Go to **Import**, choose your Excel/CSV file, confirm the Item and Price columns, set who paid (you can change the payer per row in the preview), and import. If a file has two lists side by side, import one, then choose the file again and map the other columns.

---

## Signing in

Two options on the login screen:

- **Email me a sign-in link** (no password). Supabase's built-in email sender is limited to a few emails per hour, so if three of you sign in at once you may hit the limit. If that happens, either wait, or set up free custom SMTP (for example Resend or Brevo) under **Authentication > SMTP Settings**.
- **Email + password.** Choose "Create account". If you do not want to confirm by email, turn off **Confirm email** under **Authentication > Providers > Email** in Supabase. This avoids the email limit entirely.

## Receipt photos

Photos are shrunk in your browser before upload (about 1600 px, usually 150 to 400 KB) plus a small preview. They are stored in a **private** bucket: only project members can see them, through short-lived links. The Supabase free tier includes 1 GB of storage, which is thousands of receipts.

## Updating an existing install

When a new version adds features:
1. Run the new `supabase/schema.sql` in the Supabase SQL Editor again. It only adds what is missing and keeps your data.
2. Upload the new files to GitHub, but **keep your own `js/config.js`** (it holds your keys). The site redeploys by itself.

## Reusing it for future projects

Go to **Project > Archive project** when you are done. Everything stays viewable and exportable but locked. From the project list click **New project** to start the next one with the same or different people.

Adding a member to an existing project re-splits all its expenses across the new head count, so add people before you start spending.

## Running locally and tests

```bash
npm install
npm test          # settlement, rounding and import tests (uses a copy of your real spreadsheet layout)
npm run serve     # then open the printed address
```

## Files

```
index.html            the page
css/styles.css        styling (light and dark)
js/config.js          your Supabase URL and anon key
js/app.js             shell, routing, sign-in state
js/api.js             all Supabase calls
js/store.js           shared state
js/settlement.js      equal split, balances, fewest payments (integer centavos)
js/importer.js        spreadsheet to expenses
js/money.js, image.js, util.js
js/views/             one file per screen (expenses, owners, settle, import, project, ...)
supabase/schema.sql   tables, security rules, receipt storage
tests/                unit tests
```

## Limits to know about

- Lists load up to 1,000 rows per table, far more than a prototype needs.
- The free Supabase tier pauses a project after about a week with no activity; opening the app (or the Supabase dashboard) wakes it.
