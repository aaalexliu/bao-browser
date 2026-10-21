# Drift report

Generated 2026-10-21T18:58:24.469Z. Rates exclude n/a rows. Each failure lists the attribute that broke.

| change | passed | failed | n/a | rate |
| --- | --- | --- | --- | --- |
| baseline | 5 | 0 | 0 | 100% |
| move | 5 | 0 | 0 | 100% |
| resize | 5 | 0 | 0 | 100% |
| scale | 5 | 0 | 0 | 100% |
| theme-dark | 5 | 0 | 0 | 100% |
| theme-light | 5 | 0 | 0 | 100% |
| font | 5 | 0 | 0 | 100% |
| lang | 0 | 0 | 2 | 0% |
| slow | 0 | 0 | 2 | 0% |

## Steps

| step | label | passed | failed | n/a | rate |
| --- | --- | --- | --- | --- | --- |
| wf-gnome-calculator-0 | Enter {{a}} | 7 | 0 | 0 | 100% |
| wf-gnome-calculator-1 | Click "+" | 7 | 0 | 0 | 100% |
| wf-gnome-calculator-2 | Enter {{b}} | 7 | 0 | 0 | 100% |
| wf-gnome-calculator-3 | Click "=" | 7 | 0 | 0 | 100% |
| lang |  | 0 | 0 | 2 | 0% |
| slow |  | 0 | 0 | 2 | 0% |
| wf-gedit-0 | Type {{text}} | 7 | 0 | 0 | 100% |

## Workflows

| workflow | passed | failed | n/a | rate |
| --- | --- | --- | --- | --- |
| gnome-calculator | 28 | 0 | 2 | 100% |
| gedit | 7 | 0 | 2 | 100% |

## Failures

| workflow | change | step | attribute | fixed by | reason |
| --- | --- | --- | --- | --- | --- |
| | | | | | none |

## Recovered

The first locator missed. A later locator, a repair, or a heal made the step pass.

| workflow | change | step | attribute | fixed by | reason |
| --- | --- | --- | --- | --- | --- |
| gnome-calculator | scale | wf-gnome-calculator-3 | expect | wait | expect became true |
| gnome-calculator | theme-dark | wf-gnome-calculator-3 | expect | wait | expect became true |
| gnome-calculator | theme-light | wf-gnome-calculator-3 | expect | wait | expect became true |
| gnome-calculator | font | wf-gnome-calculator-3 | expect | wait | expect became true |


## Single locator versus multi locator

Primary replays the first locator only, then the repair tiers. Multi tries role, text, test id, css, xpath, and the anchor before those repairs.

| workflow | change | primary | multi |
| --- | --- | --- | --- |
| gnome-calculator | baseline | 4/4 | 4/4 |
| gnome-calculator | move | 4/4 | 4/4 |
| gnome-calculator | resize | 4/4 | 4/4 |
| gnome-calculator | scale | 4/4 | 4/4 |
| gnome-calculator | theme-dark | 4/4 | 4/4 |
| gnome-calculator | theme-light | 4/4 | 4/4 |
| gnome-calculator | font | 4/4 | 4/4 |
| gnome-calculator | lang | n/a | n/a |
| gnome-calculator | slow | n/a | n/a |
| gedit | baseline | 1/1 | 1/1 |
| gedit | move | 1/1 | 1/1 |
| gedit | resize | 1/1 | 1/1 |
| gedit | scale | 1/1 | 1/1 |
| gedit | theme-dark | 1/1 | 1/1 |
| gedit | theme-light | 1/1 | 1/1 |
| gedit | font | 1/1 | 1/1 |
| gedit | lang | n/a | n/a |
| gedit | slow | n/a | n/a |

## Notes

GNOME Calculator is 7 + 5 =. The keypad button and its inner label share a name, so the scorer calls that a tie (role is 20 points, under the 25 point margin). Digit replay then takes the one node whose role is button. The expect is the label 12. Language packs other than en_US.utf8 are not installed, and a desktop app has no page to throttle.

gedit types into the unnamed document text view. The file is a throwaway note.txt. interpret's value postcondition is dropped because this driver does not put the buffer in `values`; the expect is the dirty-tab label `*note.txt`. GTK_THEME and GDK_DPI_SCALE are relaunched; a missed registration is retried once.