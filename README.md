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

There is also a picture-stack button beside the message box, next to Quick Persona if you use
it, so you can switch without leaving the chat.

- **Click** it for a small menu of the current persona's images. Pick one and it applies
  immediately; the one in use is outlined in gold. The last entry opens the full gallery.
- **Shift-click** it to jump straight to the next image.
- Escape or a click anywhere else closes the menu.

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
stored per persona; chat pins live in that chat's metadata and travel with the chat file, one
per persona, so switching personas inside a chat does not lose the other one's pin.

Buttons are dimmed when they cannot be used, which means no image is applied yet, or there is
no character or chat open to pin to.

Everything in the gallery can be reached from the keyboard: Tab moves between tiles, their
label and delete controls, and the pin buttons; Enter or Space activates whichever is focused.

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

## Sending images to the model

A vision-capable model can be shown what your persona looks like, rather than only told.
Under **Extensions → Persona Gallery**, set **Send images to the model** to either the image
currently applied or the whole gallery, and pick a cap for how many the whole gallery sends.

Each image is shrunk to fit within the longest-edge limit in the settings, 1024 pixels by
default, re-encoded as JPEG, and attached to your most recent message, preceded by a short line
naming the persona and the image's gallery label. That label is the place to put a hint you
want the model to act on. A smaller edge means fewer tokens per image; a larger one keeps more
detail.

Two things to keep in mind. This needs a Chat Completion API, and nothing is sent on text
completion backends. The images ride along with every request, so sending the whole gallery on
a long chat is a real and repeated token cost.

Background calls made by other extensions, such as summarisers, expression classifiers and
captioners, do not get the images. Only the generations you trigger yourself carry them.

To check what actually goes out, turn on Prompt Inspector from the wand menu and look for
`image_url` entries on your last message. Persona Gallery puts itself first in the queue of
things that touch a finished prompt, so the inspector sees the images rather than the prompt as
it stood beforehand. The browser console also logs a line for each request saying how many
reference images were attached.

### Sending descriptions instead

A text-only model can still be told what your persona looks like. With sending on, tick
**Describe images instead of sending them**. Each image is then described once by a vision
model, the text is stored, and that text goes out on every request in place of the image. You
pay for the image once rather than on every turn, and the roleplay model needs no vision
support at all.

The vision model is the one set in **Extensions → Image Captioning**. Set its **Source** to
**Multimodal** and choose an API and model there; Persona Gallery will not describe anything
until you do, because that extension otherwise sits on defaults nobody chose. The
**Description prompt** setting is what the vision model is asked. Leave it empty for a prompt
that asks for build, face, hair, eyes, skin, clothing and anything notable, in plain prose.

Descriptions are written the first time a request needs them, which makes that one request
slower. To avoid the wait, use **Describe all** in the gallery, or the description button on a
single image. That same button opens the stored text for reading and correcting, since a
vision model will sometimes get a detail wrong; **Describe again** asks for a fresh one, and
saving an empty description clears it.

Each description is added as plain text to your most recent message, in the form
`[Reference image of <persona>, <label>: <description>]`. If an image cannot be described, it is
left out of that request rather than sent as an image, and a warning shows once per session.
Token counts and other dry runs use stored descriptions but never ask for new ones.

### Placing descriptions with `{{galleryLook}}`

Your most recent message is the last thing the model reads. That is a loud place for a
paragraph about your persona's appearance, and some presets end the prompt with instructions
that are meant to stay last. To put the descriptions somewhere else, write `{{galleryLook}}`
where you want them. The usual place is the end of the persona's description in Persona
Management, so the text goes wherever your preset puts your persona:

```
{{user}} is a courier who works the night routes.

{{galleryLook}}
```

The macro renders the same text that would otherwise go on your message, for the same images.
When that text reaches the prompt, nothing is added to your message. When it does not, because
the macro is nowhere in the prompt or sits in a prompt that is switched off, the descriptions go
on your message as before. The macro renders nothing while description mode is off. If your
preset includes your persona description twice, the descriptions go out twice too.

New descriptions are written before the prompt is built, so the macro has them on the request
that first needs them. Because the macro is plain text, it also works with Text Completion
backends, which cannot carry images. There, descriptions are only written ahead of time when the
macro is in your persona description; if you put it anywhere else, use **Describe all** first.
Background prompts that include your persona description carry the stored text too, but never
ask for a new description.

## Where things are stored

Images go in your user data folder under `user/images/persona-gallery-<avatar file name>/`.
You can drop files in there by hand and they show up in the gallery. Labels, descriptions and the
record of which image is active live in `settings.json` under
`extension_settings.personaGallery`, so they travel with a settings backup.

Deleting a persona in SillyTavern clears its labels and descriptions but leaves the image folder, so nothing is
lost by accident. Delete the folder yourself if you want the files gone.

## Things worth knowing

- SillyTavern converts avatars to PNG on upload, so an animated GIF becomes a still frame once
  applied. The original file stays in the gallery untouched.
- Avatars are not resized on upload unless you crop them, so the gallery copy and the applied
  avatar are the same resolution.
- Switching rewrites the persona's avatar file in place. Anything already pointing at that file,
  including past chat messages, shows the new image. Pinning an image to a chat is the way to
  keep a particular chat looking the way you left it.
- Switching updates the chat live, including themes that paint avatars as CSS backgrounds,
  such as Moonlit Echoes' Echo and Whisper styles. Browsers keep showing the old picture for an
  unchanged URL until the page reloads, so each switch stamps a new version onto every URL for
  that persona's avatar, including ones rendered or rewritten afterwards.
- Only one switch runs at a time. A second one that arrives while the first is still writing is
  ignored, and the slash command returns an empty string so a script can tell.

## Installing elsewhere

Copy this folder into `data/<your user>/extensions/`, or into
`public/scripts/extensions/third-party/` to make it available to every account on the server.
Reload SillyTavern afterwards.
