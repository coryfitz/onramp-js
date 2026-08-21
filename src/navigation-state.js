function nextNativeNavigationStack(stack, path, initialRoute) {
  if (path === initialRoute) {
    return [initialRoute];
  }
  return [...stack, path];
}

module.exports = { nextNativeNavigationStack };
