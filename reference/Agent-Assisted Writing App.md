# Agent-Assisted Writing App

I want to build an app that will let me "co-edit" documents with the assistance of an agent. (Ideally Claude Code.)

My usual writing flow (without the assistance of an app) looks something like this:

1. Either I write the first draft myself, or the agent writes the draft based on something we're working on.
2. I then go through the doc and start making edits:
    - I'll make direct adjustments to the file.
    - Or I'll add comments to the file inline with the document in the form of (TK: <comment>)
3. I'll then ask the document to review those changes, review my comments, and give me suggested changes. It'll do a round of suggestions on the doc.
4. This goes back and forth. And we use git to keep a version history of the changes by checkpointing the document every so often.
5. Eventually, the doc gets into a state where neither of us have any meaningful suggestions, and so the document is done.

These are my requirements if I could bake something like this into an app:

1. The documents should be stored on my file system. They should be markdown files.
2. The editing experience should feel a bit like a collaborative Google Docs session:
    - I can make direct edits on the file.
    - I can make inline comments on ranges of text in the file.
    - Less important: I can make suggested changes to the file.
    - The agent can make suggested changes to the file, that I can either accept or reject and provide a comment.
    - The agent can also reply to comments or open new comments if needed.
    - Comments can be resolved by me when I'm satisfied that the thread is closed.
3. The collaboration doesn't need to be "real time". It's not me adding a comment and the agent immediately suggesting. In this way, it should be a bit more like GitHub Pull Request reviews. We do them in "turns". I'll "submit" the comments, changes, and suggestions, and then that will trigger another review cycle.
4. The app should look like a polished app for reviewing markdown files. It should at the very least have a preview mode for the markdown, if not feel more like a polished editor that renders the changes as we go.

Let's start here, and you tell me if this makes sense or if you have any questions. (Or if the idea is not viable. I'm admittedly not sure how we'd attach the app to an agent session.)

Assuming this idea is viable, the repo that we'll use is ~/dev/github.com/dru89/agent-editor. I've already created the folder, but it's empty. You can start building and designing in there.

The app needs to work on macOS and Linux at the very least. (Something like Tauri or Electron is fine to build in as long as it can do everything that I want.)

You can check out `reference/Netscope Requirements.md` in this folder (the requirements for a different app) to see some of my requirements on how window management and OS integration for that app. This app should behave similarly (though it doesn't need to be the default app for things like markdown, like that one is for `.har` files).

Make decisions that you think make sense where you feel like there's a gap. Write down those decisions in a decision log so I can review them later.

This prompt is also available as a doc called `reference/Agent-Assisted Writing App.md` in that same folder.
