const adjectives = [
  'Angry', 'Anxious', 'Async', 'Backwards', 'Bloated', 'Broken', 'Buffered', 'Caffeinated',
  'Chunky', 'Clammy', 'Confused', 'Corrupted', 'Cursed', 'Decaf', 'Deprecated', 'Distributed',
  'Drunk', 'Dusty', 'Encrypted', 'Flaky', 'Forbidden', 'Forgotten', 'Fragmented', 'Frozen',
  'Fuzzy', 'Glitchy', 'Grumpy', 'Happy', 'Haunted', 'Headless', 'Idle', 'Impatient',
  'Jittery', 'Jealous', 'Klutzy', 'Lazy', 'Leaky', 'Legacy', 'Loopy', 'Lost',
  'Loud', 'Melted', 'Moist', 'Monolithic', 'Naked', 'Nested', 'Nervous', 'Noisy',
  'Null', 'Offline', 'Overclocked', 'Overheated', 'Paranoid', 'Patched', 'Proxied',
  'Quirky', 'Recursive', 'Rusty', 'Salty', 'Scalable', 'Shaky', 'Sloppy', 'Sleepy',
  'Soggy', 'Spicy', 'Spoopy', 'Stateless', 'Stuck', 'Sweaty', 'Tangled', 'Throttled',
  'Tired', 'Undefined', 'Unplugged', 'Verbose', 'Volatile', 'Vulnerable', 'Wiggly',
  'Wobbly', 'Yelling', 'Zombified', 'Blessed', 'Crunchy', 'Electrified', 'Forgetful',
  'Rebooting', 'Zoned',
]

const nouns = [
  'API', 'ARP', 'Blob', 'Bootloader', 'Buffer', 'Bytecode', 'Cache', 'Closure',
  'Compiler', 'Container', 'Cookie', 'Cron', 'Daemon', 'Deadlock', 'Debugger',
  'Decorator', 'DHCP', 'Docker', 'Driver', 'DNS', 'Endpoint', 'Ethernet', 'Factory',
  'Firewall', 'Fork', 'Framework', 'Gateway', 'Git', 'Hub', 'Index', 'Iterator',
  'IPv6', 'Kernel', 'Lambda', 'Latency', 'Linker', 'Linter', 'Loop', 'Malloc',
  'Microservice', 'Middleware', 'Mutex', 'NAT', 'Node', 'Observer', 'Packet',
  'Pipeline', 'Pod', 'Port', 'Proxy', 'Queue', 'RAM', 'Regex', 'Registry',
  'Replica', 'Router', 'Runtime', 'Schema', 'SDK', 'Semaphore', 'Server', 'Shard',
  'Singleton', 'Socket', 'SSH', 'Stack', 'Subnet', 'Switch', 'Thread', 'Token',
  'Traceroute', 'VPN', 'Webhook', 'YAML',
]

export function randomTechName(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)]!
  const noun = nouns[Math.floor(Math.random() * nouns.length)]!
  return `${adj} ${noun}`
}
