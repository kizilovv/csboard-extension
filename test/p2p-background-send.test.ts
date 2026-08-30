/*
  The background send has one invisible dependency, and this is it.

  Steam refuses a create-offer POST whose Referer is not a trade page, and
  `Referer` cannot be set from `fetch` — it is a forbidden header. The only
  thing supplying it is the declarative rule, and nothing at runtime says so:
  drop the rule and every background send comes back as a Steam refusal that
  reads like a session problem, on a path with a tab fallback that will quietly
  paper over it. So the rule is asserted here instead.
*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

interface Manifest {
  permissions?: string[];
  host_permissions?: string[];
  declarative_net_request?: {
    rule_resources?: Array<{ id: string; enabled: boolean; path: string }>;
  };
}

interface Rule {
  id: number;
  action?: {
    type?: string;
    requestHeaders?: Array<{ header: string; operation: string; value?: string }>;
  };
  condition?: {
    urlFilter?: string;
    resourceTypes?: string[];
    initiatorDomains?: string[];
  };
}

const manifest = JSON.parse(
  readFileSync(new URL('../src/manifest.json', import.meta.url), 'utf8'),
) as Manifest;

test('the manifest registers the steamcommunity ruleset', () => {
  const resources = manifest.declarative_net_request?.rule_resources ?? [];
  const ruleset = resources.find((entry) => entry.id === 'steamcommunity_ruleset');
  assert.ok(ruleset, 'the send Referer rule must be registered or every background send fails');
  assert.equal(ruleset?.enabled, true);
  assert.equal(ruleset?.path, 'src/steamcommunity_ruleset.json');
  assert.ok(
    manifest.permissions?.includes('declarativeNetRequestWithHostAccess'),
    'the ruleset does nothing without the permission that lets it run',
  );
});

test('the rule sets a trade-page Referer on the send endpoint and nothing else', () => {
  const rules = JSON.parse(
    readFileSync(new URL('../src/steamcommunity_ruleset.json', import.meta.url), 'utf8'),
  ) as Rule[];

  assert.equal(rules.length, 1, 'one rule, so a second one cannot silently widen this');
  const [rule] = rules;

  assert.equal(rule.action?.type, 'modifyHeaders');
  assert.deepEqual(rule.action?.requestHeaders, [
    { header: 'referer', operation: 'set', value: 'https://steamcommunity.com/tradeoffer/new' },
  ]);

  // Scope. A urlFilter that matched more of Steam would be rewriting the
  // Referer on requests this extension has no business touching.
  assert.equal(rule.condition?.urlFilter, 'https://steamcommunity.com/tradeoffer/new/send');
  assert.deepEqual(rule.condition?.resourceTypes, ['xmlhttprequest']);
  assert.deepEqual(
    rule.condition?.initiatorDomains,
    ['lbaohfibjjcofpfcljmmffenioebpipl'],
    'restricted to our own extension id, so no page can borrow the rewrite',
  );
});

test('the background send did not buy itself the cookies permission', () => {
  // `sessionid` is read out of a signed-in Steam page instead. `cookies` reads
  // to the user as "read your cookies on all sites" and disables the extension
  // for every existing seller until they re-approve it.
  assert.equal(manifest.permissions?.includes('cookies'), false);
  assert.equal(manifest.permissions?.includes('tabs'), false);
});
