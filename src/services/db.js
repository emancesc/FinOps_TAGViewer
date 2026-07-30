import neo4j from 'neo4j-driver';

let driver;

export async function initDb() {
  driver = neo4j.driver(
    process.env.NEO4J_URI || 'bolt://localhost:7687',
    neo4j.auth.basic(
      process.env.NEO4J_USER || 'neo4j',
      process.env.NEO4J_PASSWORD || 'neo4j'
    )
  );
  await driver.verifyConnectivity();
  await createConstraints();
  console.log('Neo4j connected');
}

async function createConstraints() {
  const session = driver.session();
  try {
    // Rimuovi vecchio constraint ARN (non univoco: assessment nodes hanno arn='')
    await session.run('DROP CONSTRAINT resource_arn IF EXISTS').catch(() => {});

    const stmts = [
      'CREATE CONSTRAINT project_id IF NOT EXISTS FOR (p:Project) REQUIRE p.id IS UNIQUE',
      'CREATE CONSTRAINT resource_id IF NOT EXISTS FOR (r:Resource) REQUIRE r.id IS UNIQUE',
      'CREATE CONSTRAINT document_id IF NOT EXISTS FOR (d:Document) REQUIRE d.id IS UNIQUE',
    ];
    for (const s of stmts) {
      await session.run(s).catch(() => {});
    }
  } finally {
    await session.close();
  }
}

export function getDriver() {
  return driver;
}

export async function runQuery(cypher, params = {}) {
  const session = driver.session();
  try {
    const result = await session.run(cypher, params);
    return result.records;
  } finally {
    await session.close();
  }
}

export async function closeDb() {
  await driver?.close();
}
