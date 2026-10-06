# Package overrides

LaTeX packages that compiles find before TeX Live's own (`compile.ts` puts this
folder on `TEXINPUTS`, after the project folder, so a project that ships its
own copy still wins). Each one fixes a bug in the TeX Live this server runs.
Delete a file once TeX Live ships a version at least as new.

| File | Version | Why |
| --- | --- | --- |
| `lineno.sty` | 5.9 (2026/03/08), from CTAN | TeX Live 2026's lineno 5.7 puts the right column's numbers into the left column with `[switch]` (CVPR / ICCV / WACV review mode). Fixed upstream in 5.8. |
