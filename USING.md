# Using Lifeng's Foraging Fog Map

This guide is for friends who use the map at **https://lifengjin.github.io/garmin_fog_of_war/** after Lifeng has added them as a tester. You don't need GitHub, a Google Cloud account or any programming.

The map is covered in fog everywhere except where you've walked, so you can see which parts of the forest you've already covered. Your foraging spots show on top as pins.

## Your data stays yours

- **Lifeng can't see your data.** The site has no server and no database. It's just a web page that runs in your browser. Your tracks go from your Google Drive or your device straight into your own browser, and nowhere else.
- **You can't see Lifeng's data either.** Everyone's walks are stored only in their own browser and their own Drive. Opening the site on your phone shows only what you've loaded on that phone.
- **Google access is read-only.** Google asks you to allow the site to see your Drive files. It can only read, never change or delete anything, and it only downloads files from the one folder you choose. The access is kept in the page's memory and is gone when you close it.
- **The code is public.** Anyone can read exactly what the site does in this repository.

One thing to watch: anyone who uses the same browser on the same device sees what's stored there. On a shared computer, use **☰ → Settings → Remove all data from this device** when you're done.

## Before you start

Send Lifeng the Gmail or Google account address you'll use. Only accounts Lifeng has added as testers can connect Google Drive. If you sign in with a different account, Google shows "Access blocked" and the sync won't start.

You can skip Google Drive entirely and add files straight from your phone or computer (see step 5).

## 1. Get your tracks out of Garmin

Pick whichever fits.

- **Everything at once (recommended):** sign in at garmin.com, open **Account → Data Management → Export Your Data** and request an export. Garmin emails you a download link for a ZIP file, which can take a few days. The ZIP holds every activity you've recorded in Garmin Connect.
  - The export can be very large. If it's more than a few hundred MB, unzip it on a computer and keep only the ZIP files inside `DI_CONNECT/DI-Connect-Uploaded-Files`, because a phone may run out of memory reading the whole thing.
- **One activity from Garmin Connect:** open it on connect.garmin.com, click the gear icon and choose **Export Original** or **Export to GPX**.
- **From the Garmin Explore app:** open **Saved**, pick an activity, track or collection, then **Share → GPX**.

The map reads GPX, KML, KMZ, FIT and ZIP files. Only activities done on foot clear fog: hikes, walks, runs, mountaineering, hunting, fishing, snowshoeing, and activities with no sport set. Rides, drives, paddling and skiing are skipped. Waypoints saved in GPX or KML files show up as spot pins.

## 2. Make a folder in your Google Drive

1. Open Google Drive and create a folder named **Foraging map data**.
2. Put your Garmin files in it. Subfolders are fine.

Using a different name, or getting "Several folders are named…"? Open the map, tap **☰ → Settings**, and paste the folder's name or link into **Google Drive folder**.

## 3. Open the map

Open **https://lifengjin.github.io/garmin_fog_of_war/** on your phone or computer.

On a phone, add it to your home screen so it opens like an app:
- **iPhone (Safari):** Share → **Add to Home Screen**.
- **Android (Chrome):** ⋮ → **Add to Home screen**.

## 4. Sync your Drive folder

1. Tap the menu button **☰**, then **Sync Google Drive**.
2. Choose the Google account Lifeng added as a tester.
3. Google shows **"Google hasn't verified this app"**. That's expected, because this is a small personal app and not a published one. Tap **Continue**.
4. Allow **See and download all your Google Drive files**. The site only reads the one folder you chose.
5. The map downloads your files and the fog clears along your walks.

After that, a sync button **⟳** appears beside the menu. Tap it whenever you add new trips to the folder. Only new or changed files are downloaded, and files you remove from the folder disappear from the map. Google may ask you to approve again from time to time; that's normal.

## 5. Or add files without Google Drive

1. Tap **☰**, then **Add files**, and pick your GPX, KML, KMZ, FIT or ZIP files.
2. On a computer, you can also drag files onto the map.

The files are read in your browser and never uploaded.

## Using the map

- **◎** shows where you are, so you can see whether you're standing in fog.
- **Without signal:** your tracks, spots and the app are stored on your device, so they still show. Map tiles only show for areas you've viewed recently, so open the area once while you have signal.
- In **☰**, you can change how wide a strip each walk clears, how dark the fog is, which years count, the units (miles and feet, or kilometres and metres), the base map, and whether spots and walk lines show. **Only show spots matching** filters pins by name or note, for example "chanterelle".
- **Sharing a screenshot:** turn on **☰ → Hide location** first. It hides the map underneath, spot names and the scale, leaving only your walks and the fog, so the picture doesn't show where you walk. Tap **Location hidden · Show** at the top left to turn it off.
- **Base map:** with miles and feet, the map is the USGS topo map, with contour lines in feet. It only covers the United States, so outside the US pick **Topographic, metres** under **☰ → Map**.

## If something goes wrong

- **"Access blocked" from Google:** you're signed in with an account Lifeng hasn't added. Ask Lifeng to add it, or pick the right account.
- **"No Drive folder named … was found":** check the folder name, or paste the folder's link under **☰ → Settings → Google Drive folder**.
- **"Google sign-in expired":** tap sync again.
- **A walk you expected doesn't show:** check its sport in Garmin Connect. Rides, drives and similar activities don't clear fog.
