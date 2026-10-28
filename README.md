Ndownloader2
============

A small Windows download manager for sites where the real download link is
hidden behind a page that plays tricks on you. It opens the page in a real
Microsoft Edge window, waits for the actual file URL to appear, and then hands
that URL to aria2c, which downloads the file with resume support.

You paste your links once. The bot checks them, shows which are online, and
downloads the whole list into a folder you choose. No clicking every file by
hand.


What works and what does not
----------------------------

Supported:

- fuckingfast.co links, the host FitGirl Repacks uses.
  Format: https://fuckingfast.co/<id>#<filename>
- Plain direct HTTP/HTTPS file URLs from other sites. These are passed straight
  to aria2c.

Not supported:

- Other file hosts with their own click-through pages or captchas, such as
  mega.nz, 1fichier, rapidgator, keep2share or filecrypt containers. The bot
  only knows how to resolve fuckingfast.co pages. Anything else is either sent
  straight to aria2c (fine if it is a direct file URL) or fails.
- Torrents, Google Drive, or anything behind a login you have not done yourself
  in the bot's Edge window.

Everything except fuckingfast.co is untested. Treat fuckingfast.co as the one
supported host.


Requirements
------------

- Windows 10 or Windows 11
- Node.js 20 or newer (https://nodejs.org)
- Microsoft Edge (already installed on Windows)
- Internet on the first run, to fetch aria2c


Setup
-----

1. Install Node.js. Take the LTS installer from https://nodejs.org and run it.
   Then close and reopen your terminal.

2. Check the install:

       node --version

   You should see v20 or newer.

3. Get the code:

       git clone https://github.com/YOUR-USER/ndownloader2.git
       cd ndownloader2

   Or download the ZIP from GitHub and unzip it.

4. Install the single dependency:

       npm install

   This installs playwright-core only. It does not download a browser; the bot
   drives the Edge that is already on your PC.


Running
-------

Double-click run.bat, or from a terminal:

       npm start

Two things happen on the first run:

1. aria2c (about 5 MB) is downloaded automatically into tools\aria2c.exe. If
   you are offline this step fails and nothing can download.

2. A Microsoft Edge window opens with the controls loaded inside it. The page
   you paste into and the browser doing the real work are the same window, so
   Cloudflare sees an ordinary browser.

Keep the console window open. Closing it stops the bot.


First time on fuckingfast.co: one manual click
----------------------------------------------

fuckingfast.co sits behind Cloudflare. The first time the bot opens it you may
see "Verify you are human" with a checkbox.

Click it once, by hand, in the bot's Edge window.

That checkbox cannot be automated and this project does not try to. You only do
it once: the clearance is saved in the .profile folder next to the scripts and
reused on every later run. Delete .profile and you will be asked to click again.


Using it
--------

1. Paste your links into the box in the LinkGrabber tab, one per line. 100 or
   more at once is fine. Lines starting with # or // are ignored, and duplicates
   are dropped.

2. Choose the output folder with the folder button. Default is downloads\ next
   to the scripts.

3. Press Add to list. Each link is checked and marked online or offline.

4. Press Start. Files download three at a time by default.

While it runs:

- Every row shows progress, speed and estimated time left.
- Pause and Resume work per file, and there is pause all / resume all.
- The "at once" number can be changed during a batch and takes effect
  immediately.
- Slow mode caps the whole batch at 10 KB/s, handy when you want to keep
  browsing while a big file trickles in.
- The Downloads tab has a Clear list button. It clears the list, it does not
  delete files from disk.

If a download is interrupted, start it again. aria2c resumes from where it
stopped instead of beginning from zero.

Command line mode, if you prefer it:

       node cli.mjs links.txt --out "D:\Games\FitGirl" --check

Run node cli.mjs --help for the options.


Files it creates
----------------

    downloads\         default output folder
    .profile\          Edge profile that keeps the Cloudflare cookie
    .staging\          temporary folder for files that cannot be written
                       straight to the target disk
    logs\              one aria2c log per download
    tools\aria2c.exe   the downloader, fetched on first run

All of these are excluded by .gitignore.


Troubleshooting
---------------

aria2c is missing or the first run stops early
    You are offline, or github.com is blocked. Download aria2 yourself from
    https://github.com/aria2/aria2/releases (release 1.37.0,
    aria2-1.37.0-win-64bit-build1.zip) and put aria2c.exe in tools\.

Links show offline
    Look at the bot's Edge window. If Cloudflare is showing a checkbox, click
    it, then check the links again.

A download fails with "Invalid range header"
    The host does not honour byte ranges. The bot already forces one connection
    per file, so this should not appear. If it does, that file has to restart
    from the beginning.

Access denied when writing to the chosen folder
    Windows is blocking the write. Pick a folder inside your user profile, such
    as D:\Games\FitGirl, or run run.bat as administrator once. If a file cannot
    be written to the target disk, the bot falls back to .staging\ and moves it
    into place afterwards.

No Edge window appears
    Check the taskbar. The console window must stay open, because it owns the
    browser process.

Port 8787 already in use
    Another copy is already running. Close it, or use a different port:

       set PORT=8788
       npm start


Notes
-----

- The bot does not solve captchas, bypass logins, or disguise itself. It uses a
  real Edge window that you can see and use.
- Use it for files you are allowed to download.
- No installer, no background service, no telemetry.


License
-------

MIT
