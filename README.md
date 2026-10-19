# SnoofShooter
A spin off of one of my favorite phone games to play as a pass time. A casual puzzle and arcade mobile game where players tap to launch energy bursts or blocks to clear chaotic grids and build pixel art.

## How to play
- Tap the front shooter in any column to send it to the dock (5 slots).
- Docked shooters fire energy bursts at the **lowest block** in each column that matches their color.
- The number on a shooter is its ammo. At 0 it leaves and frees its slot.
- Clear every block to build the picture. If the dock is full and nobody can shoot, you lose.

## Running it locally
It's plain HTML/CSS/JavaScript, with no build step. From the project folder:

```
py -m http.server 5173
```

Then open http://localhost:5173.

## Playing on iPhone
1. Push to GitHub, then in the repo go to **Settings → Pages**, set the source to the `main` branch with the `/ (root)` folder, and save.
2. After a minute, open `https://snoofus27.github.io/Snoofshooter/` in Safari on your iPhone.
3. Tap **Share → Add to Home Screen** and it launches full screen like an app.

## Project layout
- `index.html`: page shell, menus and overlays
- `style.css`: styling
- `src/game.js`: game engine (generation, shooting, drawing, input, sound)
- `src/levels.js`: the pixel-art levels. **Add your own here.** Each character is a color.
