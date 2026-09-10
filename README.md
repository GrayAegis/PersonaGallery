# Persona Gallery

Give each SillyTavern persona a set of images instead of a single avatar, and switch between
them from inside SillyTavern.

## What it does

A persona in SillyTavern is identified by its avatar file, so a persona can only ever have one
picture. This extension keeps a folder of images per persona and copies the one you pick over
that avatar file. The persona keeps its name, description, lorebook links, chat locks and
character connections, because none of those are stored in the image.

## Using it

Open **Persona Management**. Next to the existing persona buttons there is a new
picture-stack button.

- **Click** it to open the gallery for the current persona.
- **Shift-click** it to jump straight to the next image.

Inside the gallery:

- Click a tile to make that image the persona's avatar. The current one is outlined in gold.
- **Add images** opens a file picker, or you can drop image files onto the window.
- Each image is labelled with the file name it arrived under. The tag icon changes that label,
  and the label is what the slash commands match on.
- The bin icon removes the image from the gallery folder without touching the persona.

The first time you open a gallery for a persona, the avatar it already has is copied in as
`Original`, so switching away from it is reversible. Any picture you later set with
SillyTavern's own Change Persona Image button is captured into the gallery too, so a switch
can never discard it. Turn the first-time copy off under **Extensions → Persona Gallery** if
you would rather start empty.

## Pinning an image

The row under the grid pins whichever image is currently applied, in the same three scopes
SillyTavern uses for personas themselves.

| Pin | Effect |
| --- | --- |
| Default | Use this image whenever no other rule applies |
| Character | Use this image while this character or group is open |
| Chat | Use this image while this chat is open |

The most specific rule wins, so a chat pin beats a character pin, which beats the default.
Pins are re-evaluated when you open a chat and when you change persona, so wandering off to
another image by hand lasts only until the next chat load. Character pins and the default are
stored per persona; a chat pin lives in that chat's metadata and travels with the chat file.

Buttons are dimmed when they cannot be used, which means no image is applied yet, or there is
no character or chat open to pin to.

## Slash commands

| Command | Effect |
| --- | --- |
| `/persona-gallery` | Opens the gallery for the current persona |
| `/persona-image` | Lists the current persona's images |
| `/persona-image next` | Switches to the next image |
| `/persona-image prev` | Switches to the previous image |
| `/persona-image Winter coat` | Switches by label, or by file name |
| `/persona-image 2` | Switches by position in the list |

They all act on the currently selected persona.

## Where things are stored

Images go in your user data folder under `user/images/persona-gallery-<avatar file name>/`.
You can drop files in there by hand and they show up in the gallery. Labels and the record of
which image is active live in `settings.json` under `extension_settings.personaGallery`, so
they travel with a settings backup.

Deleting a persona in SillyTavern clears its labels but leaves the image folder, so nothing is
lost by accident. Delete the folder yourself if you want the files gone.

## Things worth knowing

- SillyTavern converts avatars to PNG on upload, so an animated GIF becomes a still frame once
  applied. The original file stays in the gallery untouched.
- Avatars are not resized on upload unless you crop them, so the gallery copy and the applied
  avatar are the same resolution.
- Switching rewrites the persona's avatar file in place. Anything already pointing at that file,
  including past chat messages, shows the new image. Pinning an image to a chat is the way to
  keep a particular chat looking the way you left it.
- Only one switch runs at a time. A second one that arrives while the first is still writing is
  ignored, and the slash command returns an empty string so a script can tell.

## Installing elsewhere

Copy this folder into `data/<your user>/extensions/`, or into
`public/scripts/extensions/third-party/` to make it available to every account on the server.
Reload SillyTavern afterwards.
