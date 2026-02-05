// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PUBLIC_API = process.env.PUBLIC_API || 'http://localhost:4000/api';

/**
 * Generate an auth token for API requests
 */
function generateAuthToken(userId, userEmail, secret) {
  const { createHmac } = require('crypto');
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { sub: userId, email: userEmail, iat: Math.floor(Date.now() / 1000) };
  const b64h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const b64p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${b64h}.${b64p}`).digest('base64url');
  return `${b64h}.${b64p}.${sig}`;
}

test.describe('Nested comments (3 levels deep)', () => {
  test('creates and retrieves 3-level nested comment thread', async ({ request }) => {
    const secret = process.env.NEXTAUTH_SECRET || 'dev-secret';

    // Create three test users
    const user1Id = `user-${Date.now()}-1`;
    const user2Id = `user-${Date.now()}-2`;
    const user3Id = `user-${Date.now()}-3`;
    const user1Email = `${user1Id}@test.local`;
    const user2Email = `${user2Id}@test.local`;
    const user3Email = `${user3Id}@test.local`;

    const token1 = generateAuthToken(user1Id, user1Email, secret);
    const token2 = generateAuthToken(user2Id, user2Email, secret);
    const token3 = generateAuthToken(user3Id, user3Email, secret);

    // Get an existing work and source
    const worksResp = await request.get(`${PUBLIC_API}/works`);
    expect(worksResp.ok()).toBeTruthy();
    const works = (await worksResp.json()).works;
    expect(works.length).toBeGreaterThan(0);

    const workId = works[0].workId;

    // Get work details to find a source and revision
    const workResp = await request.get(`${PUBLIC_API}/works/${encodeURIComponent(workId)}`);
    expect(workResp.ok()).toBeTruthy();
    const work = await workResp.json();
    expect(work.sources.length).toBeGreaterThan(0);

    const sourceId = work.sources[0].sourceId;
    const revisionId = work.sources[0].revisions[0].revisionId;

    console.log(`Testing nested comments on ${workId}/${sourceId}/${revisionId}`);

    // Level 1: User 1 posts a top-level comment
    const comment1Resp = await request.post(
      `${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/revisions/${encodeURIComponent(revisionId)}/comments`,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token1}`
        },
        data: { content: 'This is the top-level comment from user 1' }
      }
    );
    expect(comment1Resp.ok()).toBeTruthy();
    const comment1 = await comment1Resp.json();
    const comment1Id = comment1.commentId;
    expect(comment1Id).toBeTruthy();
    console.log(`✓ Level 1 comment created: ${comment1Id}`);

    // Level 2: User 2 replies to User 1's comment
    const comment2Resp = await request.post(
      `${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/revisions/${encodeURIComponent(revisionId)}/comments`,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token2}`
        },
        data: {
          content: 'This is a reply from user 2 to user 1',
          parentCommentId: comment1Id
        }
      }
    );
    expect(comment2Resp.ok()).toBeTruthy();
    const comment2 = await comment2Resp.json();
    const comment2Id = comment2.commentId;
    expect(comment2Id).toBeTruthy();
    console.log(`✓ Level 2 comment created: ${comment2Id} (parent: ${comment1Id})`);

    // Level 3: User 3 replies to User 2's comment
    const comment3Resp = await request.post(
      `${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/revisions/${encodeURIComponent(revisionId)}/comments`,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token3}`
        },
        data: {
          content: 'This is a nested reply from user 3 to user 2',
          parentCommentId: comment2Id
        }
      }
    );
    expect(comment3Resp.ok()).toBeTruthy();
    const comment3 = await comment3Resp.json();
    const comment3Id = comment3.commentId;
    expect(comment3Id).toBeTruthy();
    console.log(`✓ Level 3 comment created: ${comment3Id} (parent: ${comment2Id})`);

    // Retrieve all comments and verify nested structure
    const commentsResp = await request.get(
      `${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/revisions/${encodeURIComponent(revisionId)}/comments`,
      {
        headers: { 'Authorization': `Bearer ${token1}` }
      }
    );
    expect(commentsResp.ok()).toBeTruthy();
    const comments = await commentsResp.json();

    console.log(`Retrieved ${comments.length} top-level comments`);

    // Find our comment thread
    const topLevelComment = comments.find(c => c.commentId === comment1Id);
    expect(topLevelComment).toBeTruthy();
    expect(topLevelComment.content).toBe('This is the top-level comment from user 1');
    console.log(`✓ Found top-level comment with content`);

    // Verify Level 2 is nested under Level 1
    expect(topLevelComment.replies).toBeTruthy();
    expect(topLevelComment.replies.length).toBeGreaterThan(0);

    const level2Comment = topLevelComment.replies.find(c => c.commentId === comment2Id);
    expect(level2Comment).toBeTruthy();
    expect(level2Comment.content).toBe('This is a reply from user 2 to user 1');
    console.log(`✓ Found level 2 comment nested under level 1`);

    // Verify Level 3 is nested under Level 2
    expect(level2Comment.replies).toBeTruthy();
    expect(level2Comment.replies.length).toBeGreaterThan(0);

    const level3Comment = level2Comment.replies.find(c => c.commentId === comment3Id);
    expect(level3Comment).toBeTruthy();
    expect(level3Comment.content).toBe('This is a nested reply from user 3 to user 2');
    console.log(`✓ Found level 3 comment nested under level 2`);

    console.log('✅ 3-level nested comment structure verified successfully!');
    console.log(`Structure: ${comment1Id} -> ${comment2Id} -> ${comment3Id}`);
  });

  test('displays nested comments correctly in UI', async ({ page, request }) => {
    const secret = process.env.NEXTAUTH_SECRET || 'dev-secret';

    // Create two test users
    const user1Id = `user-${Date.now()}-ui-1`;
    const user2Id = `user-${Date.now()}-ui-2`;
    const user1Email = `${user1Id}@test.local`;
    const user2Email = `${user2Id}@test.local`;

    const token1 = generateAuthToken(user1Id, user1Email, secret);
    const token2 = generateAuthToken(user2Id, user2Email, secret);
    const username1 = `user${Date.now().toString().slice(-6)}a`;
    const username2 = `user${Date.now().toString().slice(-6)}b`;

    const usernameResp1 = await request.patch(`${PUBLIC_API}/users/me`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token1}`
      },
      data: { username: username1 }
    });
    expect(usernameResp1.ok()).toBeTruthy();

    const usernameResp2 = await request.patch(`${PUBLIC_API}/users/me`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token2}`
      },
      data: { username: username2 }
    });
    expect(usernameResp2.ok()).toBeTruthy();

    // Get an existing work
    const worksResp = await request.get(`${PUBLIC_API}/works`);
    const works = (await worksResp.json()).works;
    const workId = works[0].workId;

    const workResp = await request.get(`${PUBLIC_API}/works/${encodeURIComponent(workId)}`);
    const work = await workResp.json();
    const sourceId = work.sources[0].sourceId;
    const revisionId = work.sources[0].revisions[0].revisionId;

    // Create nested comments via API
    const comment1Resp = await request.post(
      `${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/revisions/${encodeURIComponent(revisionId)}/comments`,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token1}`
        },
        data: { content: 'UI test: top level comment' }
      }
    );
    const comment1 = await comment1Resp.json();
    const comment1Id = comment1.commentId;

    const comment2Resp = await request.post(
      `${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/revisions/${encodeURIComponent(revisionId)}/comments`,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token2}`
        },
        data: {
          content: 'UI test: nested reply',
          parentCommentId: comment1Id
        }
      }
    );

    // Navigate to the work page
    await page.goto(`${BASE_URL}/works/${encodeURIComponent(workId)}`);

    // Wait for page to load
    await page.waitForLoadState('networkidle');

    // Find and click on the source card to expand it
    const sourceCard = page.locator(`text=${work.sources[0].label}`).first();
    await sourceCard.click();

    // Wait for source details to appear
    await page.waitForTimeout(500);

    // Look for "Revision history" and click it
    const revisionHistory = page.locator('text=Revision history');
    if (await revisionHistory.count() > 0) {
      await revisionHistory.first().click();
      await page.waitForTimeout(500);
    }

    // Check if comments are visible
    const topComment = page.locator(`text=UI test: top level comment`);
    await expect(topComment).toBeVisible({ timeout: 5000 });
    console.log('✓ Top-level comment visible in UI');

    const nestedComment = page.locator(`text=UI test: nested reply`);
    await expect(nestedComment).toBeVisible({ timeout: 5000 });
    console.log('✓ Nested comment visible in UI');

    const usernameLink1 = page.locator(`a:has-text("${username1}")`).first();
    const usernameLink2 = page.locator(`a:has-text("${username2}")`).first();
    await expect(usernameLink1).toBeVisible({ timeout: 5000 });
    await expect(usernameLink2).toBeVisible({ timeout: 5000 });
    await expect(usernameLink1).toHaveAttribute('href', `/users/${username1}`);
    await expect(usernameLink2).toHaveAttribute('href', `/users/${username2}`);

    // Verify indentation (nested comment should have marginLeft applied)
    const nestedCommentElement = await nestedComment.locator('..').locator('..').first();
    const marginLeft = await nestedCommentElement.evaluate(el => el.style.marginLeft);
    expect(marginLeft).toBeTruthy();
    expect(marginLeft).not.toBe('0');
    expect(marginLeft).not.toBe('0px');
    console.log(`✓ Nested comment has indentation: ${marginLeft}`);

    console.log('✅ Nested comments display correctly in UI!');
  });
});
