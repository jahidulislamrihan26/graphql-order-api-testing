export const typeDefs = /* GraphQL */ `
  enum OrderStatus {
    PENDING_PAYMENT
    PAID
    FULFILLING
    SHIPPED
    DELIVERED
    CANCELLED
    RETURN_REQUESTED
    RETURNED
  }

  type Product {
    id: ID!
    name: String!
    priceCents: Int!
    stock: Int!
  }

  type ProductConnection {
    items: [Product!]!
    nextCursor: ID
  }

  type CartItem {
    product: Product!
    quantity: Int!
  }

  type Cart {
    items: [CartItem!]!
    totalCents: Int!
  }

  type OrderItem {
    product: Product!
    quantity: Int!
    unitPriceCents: Int!
  }

  type OrderEvent {
    type: String!
    fromStatus: String
    toStatus: String
    source: String!
    createdAt: String!
  }

  type Order {
    id: ID!
    status: OrderStatus!
    totalCents: Int!
    items: [OrderItem!]!
    events: [OrderEvent!]!
    createdAt: String!
  }

  type Notification {
    kind: String!
    orderId: ID!
    createdAt: String!
  }

  type User {
    id: ID!
    email: String!
    orders(first: Int = 20): [Order!]!
  }

  type Query {
    products(first: Int = 10, after: ID): ProductConnection!
    product(id: ID!): Product
    me: User
    order(id: ID!): Order
    cart: Cart!
    notifications: [Notification!]!
  }

  type Mutation {
    addToCart(productId: ID!, quantity: Int!): Cart!
    removeFromCart(productId: ID!): Cart!
    checkout: Order!
    cancelOrder(orderId: ID!): Order!
    requestReturn(orderId: ID!, reason: String!): Order!
    markFulfilling(orderId: ID!): Order!
    completeReturn(orderId: ID!): Order!
  }
`;
