# Requirements and design principles for Netscope

The goal of the app is to *feel* native for the user, even if it runs as an electron app. We should do our best to adopt anything that's a convention of the platform and not disappoint the user by missing some OS-level feature that they'd expect to be present.

## OS integration

### Icons

- The app icons are all in `build/`
- The app's main icons are `build/icon.icns`, `build/icon.png`, and `build/icon.ico` depending on what's needed for the OS.
- For a file icon (to decorate `.har` files), when needed, there's build/har-document.ico. This is mostly only needed on Windows.
- On macOS, you can get the native "file curl" icon for `.har` files. This took some figuring out and the instructions are in `docs/macos-document-icons.md`

### Window management

- Double clicking on a `.har` file in a file explorer should open up that file in a window of Netscope.

- Creating new windows should:
    - The *first* new window should be roughly centered on the screen.
    - After that, new windows should "cascade" off the currently focused window's position.
    - If the OS can't determine the position of a window, go back to choosing the center of the screen.
    - (Wayland appears to have a problem with tracking the position of a window *after* it moves. But it knows that a window *did* move. So if the focused window never moves, then the next window should cascade off that one. If the focused window moves but we don't know the position, place the new window in the center position.)
- Deciding which window to use when opening a HAR file:
    - If the user is clicking a file in the Explorer:
        - If that file is already open somewhere, focus on that window.
        - Otherwise, open a new window (using the logic for "creating new windows") with that file
    - If the user uses "Ctrl-O" to select a file:
        - If the currently focused window is on the "welcome page", use that window.
        - Otherwise if the file is already open in a different window, focus that window
        - Otherwise, open a new window (using the logic for "creating new windows")
    - If the user selects the "Open File" button the "welcome page":
        - Always use the focused "welcome page" window for the selected file.

- When the app has multiple windows open, make sure it's all running from the **same app process**. Electron has a tendency to want to open new app instances for each window, so make sure we're putting all the windows on the same process.

- Prefer to use the natural window titlebar for the window. The title of the window should be the file's name (`Example request.har`)

- By default, new windows show the "welcome page" screen. Which has a bit of information about the app and a prominent button to let the user open a file.

- The "About Window" is a special, small window: TK

### Automatic Updates

TK

### Menu bar commands

The app should make use of the File/Edit/etc normal menu bar.

Prefer to use the native OS version of controls for things when possible instead of writing our own implementation.

- On macOS, the first entry is always for the app ("Netscope"). Under that, you should find:
    - "About Netscope" (shows an About window)
    - separator
    - "Services"
    - separator
    - "Hide"
    - "Hide Others"
    - "Unhide"
    - separator
    - "Quit"
- Under "File"
    - "New Window"
    - "Open HAR File…"
    - "Open Recent"
        - <list of recent files>
        - separator (if length > 0)
        - "Clear Menu" (enabled if length > 0)
- "Edit"
    - "Undo"
    - "Redo"
    - separator
    - "Cut"
    - "Copy"
    - "Paste"
    - "Select All"
- "View"
    - "Reload"
    - "Force Reload"
    - "Toggle Dev Tools"
    - separator
    - "Reset Zoom"
    - "Zoom In"
    - "Zoom Out"
    - separator
    - "Toggle Full Screen"
- windowMenu
- "Help"
    - "Netscope Website" (goes to https://netscope.app.com)
    - "Report an Issue" (goes to https://github.com/dru89/netscope/issues, but we might be able to make this better by taking them to a template)
    - [if not macOS]: separator
    - [if not macOS]: "About Netscope" (show about window)
    
#### Recent file logic

Keeping track of recent documents isn't something that every OS does well, so we may have to implement our own version of this. But prefer to use the app's document tracking if possible.

### Keyboard shortcuts

- Cmd-N (macOS) or Ctrl-N (win/linux): opens a new window
- Cmd-O (macOS) or Ctrl-O (win/linux): opens an existing HAR file from an explorer view
- Cmd-W (macOS) or Ctrl-W (win/linux): closes the current window
