import { eq, isNotNull, or, schema } from "@helpos/db";

const { messages } = schema;

/**
 * The messages a conversation's history shows: everything received, and replies once delivery is
 * confirmed. An unconfirmed send attempt may never have reached the customer.
 */
export const inHistory = () => or(eq(messages.direction, "inbound"), isNotNull(messages.sentAt));
