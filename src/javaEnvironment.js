// Machine-wide Java flags can inject incompatible agents, heaps or classpaths
// even when a launcher specifies the correct java.exe explicitly.
export function cleanJavaEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => ![
    'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH'
  ].includes(key.toUpperCase())));
}
