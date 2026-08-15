# onramp-js

`onramp-js` creates the generated React Native frontend used by the OnRamp
Python app framework.

## Usage

```sh
npx onramp-js create --name myapp --output /path/to/myapp/build
```

The `create` command writes the frontend project, installs its npm
dependencies, and generates its initial file-based route registry.

This package is normally invoked by the Python `onramp` command rather than
directly by application developers.
