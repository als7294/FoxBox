# Before this repo goes public (checklist)
The repo is **private** for now, on GitHub account `als7294` (SmittyTech). Do all of this before flipping it to public:

1. **Identity in the history (handled by snapshot publishing: GitHub only receives snapshot commits authored as SmittyTech <89995047+als7294@users.noreply.github.com>).** Past local commits carry personal author emails.
   - Publish from a **fresh, squashed history** authored as SmittyTech, with the account's GitHub noreply address.
   - Or rewrite the authors. Either way, do it only after the parallel sessions are finished and merged.
2. **Persona scrub.** 67 tracked files mention "GUY FVWKS". Make the defaults neutral or configurable:
   - the artist tag, placeholder scripts and filename pattern (`GUYFVWKS_…`);
   - the fixtures and planning docs (`docs/PLAN.md`, `docs/sessions/*`).
   - Or remove the internal docs from the public tree.
3. **Secrets check.** Confirm there are no tokens, local paths or personal data in the configs, tests or examples.
4. **License.** GPL-3.0 (`LICENSE`), with `THIRD_PARTY_NOTICES.md` up to date. Make sure the vendored Airwindows files keep their MIT license text.
5. **Releases.** Once the repo is public, the in-app updater reads GitHub Releases without a token.
