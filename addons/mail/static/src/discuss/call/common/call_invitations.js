import { CallInvitation } from "@mail/discuss/call/common/call_invitation";

import { Component } from "@odoo/owl";

import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

export class CallInvitations extends Component {
    static props = [];
    static components = { CallInvitation };
    static template = "discuss.CallInvitations";

    setup() {
        super.setup();
        this.rtc = useService("discuss.rtc");
        this.store = useService("mail.store");
    }
}

export const callInvitationsService = {
    dependencies: ["discuss.rtc", "mail.store"],
    start() {
        registry
            .category("main_components")
            .add("discuss.CallInvitations", { Component: CallInvitations });
    },
};
registry.category("services").add("discuss.call_invitations", callInvitationsService);
