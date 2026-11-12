# ClassQuiz

A live quiz game for your classroom. You show the questions on the projector, students answer on their phones, points go to whoever answers right *and* fast, and there's a leaderboard after every question and a podium at the end.

No accounts, no installs for students, no database, no extra packages — just one small Node.js server.

## How a game works

1. **You** open `/host` (e.g. `https://your-site.com/host`), pick or create a quiz, and press **▶ Host live**.
2. The projector shows the website address, a **6-digit PIN** and a QR code.
3. **Students** open the website on their phones (or scan the QR), type the PIN and a nickname.
4. Press **Start** (or the space bar). For each question: a few seconds to read it → answer time with a countdown → results chart → leaderboard.
5. At the end: podium for the top 3, and a **Download results (CSV)** button that opens in Excel/Sheets.

**Scoring:** a correct answer earns 500–1000 points depending on speed, plus a streak bonus (+50 per correct answer in a row, up to +200). The question ends early once everyone has answered.

**Making quizzes:** use the editor (multiple choice with 2–4 answers, or True/False, with a time limit per question), or click **Paste many at once** and type them like this:

```
Capital of France? [15s]
- Madrid
* Paris
- Rome

The Sun is a star.
* True
- False
```

`*` marks the correct answer, `[15s]` sets the time (default 20 s). Quizzes are saved in your browser — use **Export** / **Import** to back them up or move them to another computer.

Other handy things: click a student's name in the lobby to remove them (e.g. a rude nickname); students can rejoin if their phone refreshes or locks; late students can still join mid-game.

---

## Option A — Run it from your laptop (quickest, free)

Works when your laptop and the students' phones are on the **same Wi-Fi**.

1. Install Node.js (the "LTS" version) from https://nodejs.org.
2. Unzip this folder, open a terminal in it and run:
   ```
   node server.js
   ```
3. It prints two addresses. Open the **Teacher** one (`http://localhost:3000/host`) on your laptop. The host screen automatically shows students the network address to use (like `192.168.1.25:3000`).

If students can't connect, the school Wi-Fi may block devices from talking to each other ("client isolation") — use Option B instead.

## Option B — Put it online (works anywhere)

Any host that runs Node.js works. A free option is **Render**:

1. Create a free account at https://github.com and make a new repository; upload all the files from this folder (keep the `public` folder).
2. Create a free account at https://render.com → **New → Web Service** → connect your GitHub repository.
3. Settings: **Runtime** Node · **Build command** `npm install` · **Start command** `node server.js` · **Instance type** Free.
4. Deploy. You'll get an address like `https://classquiz-xyz.onrender.com`. Your host page is that address + `/host`.

Note: Render's free tier "sleeps" after 15 minutes without visitors, so open your `/host` page a minute before class to wake it up.

Other hosts that work the same way: Railway, Fly.io, Koyeb, or any VPS (`PORT` environment variable is respected).

## Good to know

- Games live in the server's memory: restarting the server ends any game in progress (your quizzes are safe — they're in your browser). Idle games are cleared after 3 hours.
- Up to 200 players per game; many games can run at once (each has its own PIN).
- If you refresh the host page during a game, it reconnects to the same game.

## Files

```
server.js          the game server (no dependencies)
public/index.html  host screens + student screens
package.json
```
