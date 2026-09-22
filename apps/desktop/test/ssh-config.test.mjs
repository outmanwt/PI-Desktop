import assert from "node:assert/strict";
import test from "node:test";
import { parseSshConfig } from "../electron/main/remote/ssh-config.ts";

test("parses concrete SSH aliases and ignores wildcard hosts", () => {
  const profiles = parseSshConfig(`
Host *
  User ignored
Host home-server
  HostName 192.168.1.10
  User alice
  Port 2222
  IdentityFile ~/.ssh/id_home
Host !excluded *.internal
  HostName ignored
`);
  assert.deepEqual(profiles, [
    {
      alias: "home-server",
      host: "192.168.1.10",
      user: "alice",
      port: 2222,
      identityFile: "~/.ssh/id_home",
    },
  ]);
});

test("keeps aliases safe and does not accept option injection", () => {
  const profiles = parseSshConfig(`
Host -oProxyCommand=bad
  HostName bad
Host safe
  HostName target
`);
  assert.deepEqual(profiles.map((profile) => profile.alias), ["safe"]);
});

test("keeps first SSH values for repeated Host blocks", () => {
  const profiles = parseSshConfig(`
Host server
  HostName first.example
  User first
Host server
  HostName second.example
  User second
`);
  assert.equal(profiles[0]?.host, "first.example");
  assert.equal(profiles[0]?.user, "first");
});
