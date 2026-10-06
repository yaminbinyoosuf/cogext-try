const CLAIM_VERBS = ['sent', 'wrote', 'written', 'updated', 'posted', 'completed', 'done', 'successfully', 'finished', 'delivered', 'created', 'saved', 'executed'];
export function detectClaim(text) {
    const lower = text.toLowerCase();
    return CLAIM_VERBS.some(v => lower.includes(v));
}
export function extractClaim(text) {
    const sentences = text.split(/[.!?]/);
    for (const s of sentences) {
        if (CLAIM_VERBS.some(v => s.toLowerCase().includes(v))) {
            return s.trim().slice(0, 120);
        }
    }
    return text.slice(0, 120);
}
