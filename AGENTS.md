# Repository instructions

- Read and follow `RELEASING.md` for every versioned functional change.
- A functional change is not complete until the tested `main` commit is pushed and a matching GitHub Release is published or updated according to `RELEASING.md`.
- Keep the Chrome extension and Tampermonkey userscript on one shared semantic version from v1.3.0 onward.
- Never force-move an existing release tag, overwrite a historical release, or delete a release unless the user explicitly requests it.
- Every release must attach both the Chrome extension ZIP and the installable `.user.js` file.
- Never store account passwords, access tokens, cookies, or other credentials in the repository, release notes, assets, command arguments, or Git remote URL.
