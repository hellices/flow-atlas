import { Injectable } from '@nestjs/common';

export interface Cat {
  id: string;
  name: string;
}

@Injectable()
export class CatsService {
  private readonly cats: Cat[] = [];

  create(cat: Partial<Cat>): Cat {
    const created = { id: String(this.cats.length + 1), name: 'Unnamed', ...cat };
    this.cats.push(created);
    return created;
  }

  findAll(): Cat[] {
    return this.cats;
  }

  findOne(id: string): Cat | undefined {
    return this.cats.find((cat) => cat.id === id);
  }
}
