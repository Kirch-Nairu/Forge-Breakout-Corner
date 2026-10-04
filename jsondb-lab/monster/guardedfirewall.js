'use strict';

const { AuthorityFirewall } = require('./authorityfirewall');

class GuardedAuthorityFirewall extends AuthorityFirewall {
  async decide(actor, action, detail = {}) {
    await this.init();
    const before = await this.verifyLedger();
    if (!before.valid) {
      const error = new Error(`Authority Firewall ledger is invalid; refusing to append ${actor} -> ${action}.`);
      error.status = 409;
      error.firewallLedger = before;
      throw error;
    }
    return super.decide(actor, action, detail);
  }
}

module.exports = { GuardedAuthorityFirewall };
